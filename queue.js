var uuid = require('ezuuid');
var _ = require('lodash');
var defaultExchangePublish = require('./default-exchange-publish');
var Promise = require('bluebird');
var getConnection = require('./get-connection');

var EXCHANGE_ATTRIBUTE_NAMES = [
	'durable',
	'autoDelete',
	'arguments',
	'internal',
	'alternateExchange',
];

var DEFAULTS = {
	exclusive: false,
	autoDelete: false,
	durable: true,
	ack: true,
	useErrorQueue: false,
};

function _log(level, ...args) {
	const fn = _.get(global.logger, level);

	if (fn) {
		fn(...args);
	} else {
		console.log(`[${level}] ${args}`);
	}
}

function assertQueue(connString, queueName, exchangeNames, params){
	return getConnection(connString)
		.then(function(conn){
			return conn.createChannel();
		})
		.then(function(chan){
			return chan.assertQueue(queueName, params)
				.then(_.constant(chan));
		});
}

function getNoAckParam(params){
	if (params.noAck !== undefined && params.ack !== undefined){
		throw new Error('cannot specifiy both ack and noAck params');
	}

	if (params.noAck !== undefined) return !!params.noAck;
	if (params.ack !== undefined) return !params.ack;

	// default is to ack
	return false;
}

function _patternToMatcher(pattern) {
	if (!pattern) return _.constant(false);
	// https://github.com/mateodelnorte/amqp-match/blob/master/index.js
	const regexString = '^' + pattern.replace(/\*/g, '([^.]+)').replace(/#/g, '([^.]+.?)+') + '$';

	return function(str) {
		if (!str) return false;
		if (str === pattern) return true;

		return str.search(regexString) !== -1;
	};
}

function Queue(connString, params){
	params = _.extend({}, DEFAULTS, params);

	var name = params.name || ((params.namePrefix || '') + uuid()),
		useErrorQueue = !!params.useErrorQueue,
		errorQueueName = name + '_error',
		prefetchCount = params.prefetchCount|| 1,
		ctag,
		noAck = getNoAckParam(params),
		attempts = params.attempts,
		closing = false;


	if (noAck) {
		prefetchCount = 0;
	}

	var bindings = _.chain([params.exchangeNames])
		.concat([params.exchangeName])
		.concat([params.bindings])
		.concat([params.exchanges])
		.flatten()
		.filter(Boolean)
		.map(function(ex){
			if (_.isObject(ex)) return ex;
			if (_.isString(ex)) return  { name: ex };
			throw new Error('invalid binding/exchange');
		})
		.uniq(function(binding){ return [binding.name, binding.key].join('_'); })
		.forEach(function(binding){
			if (binding.key !== undefined) return;

			binding.key = binding.key || (params.key || '#').toString();
		})
		.value();

	const labeledBindings = bindings.filter(b => b.label && b.key);
	labeledBindings
		.forEach(b => {
			b.isMatch = _patternToMatcher(b.key);
		});

	delete params.exchangeName;
	delete params.exchangeNames;
	delete params.bindings;
	delete params.name;
	delete params.useErrorQueue;
	delete params.key;
	delete params.noAck;
	delete params.ack;

	function bindQueue(chan, bindings){
		return _.chain(bindings)
			.toArray()
			.map(function(binding){
				if (binding.type){
					var exParams = _.chain(EXCHANGE_ATTRIBUTE_NAMES)
						.filter(function(k){ return binding[k] !== undefined; })
						.map(function(k){ return [k, binding[k]]; })
						.fromPairs()
						.value();

					return chan.assertExchange(binding.name, binding.type, exParams)
						.then(function(){ return chan.bindQueue(name, binding.name, binding.key); });
				}

				return chan.bindQueue(name, binding.name, binding.key);
			})
			.thru(Promise.all)
			.value()
			.then(_.constant(chan));
	}

	var queuePromise = assertQueue(connString, name, bindings, params)
		.then(function(chan){
			chan.on('error', function(err){
				console.log('error binding ' + name);
				console.log(err.message);
				console.error(err);
				console.log('------------------------');
			});

			return Promise.resolve(true)
				.then(function(){
					return chan;
				})
				.then(function(chan){
					if (useErrorQueue){
						return chan.assertQueue(errorQueueName, { durable: true })
							.then(_.constant(chan));
					}

					return chan;
				})
				.then(function(chan){
					return chan.prefetch(prefetchCount)
						.then(_.constant(chan));
				})
				.then(function(chan) {
					return bindQueue(chan, bindings);
				})
				.then(function(chan){
					if (_.isFunction(params.ready)) {
						params.ready();
					}

					return chan;
				})
				.catch(function(err){
					console.error(err);
					return false;
				});
		});

	var receiveFunc = function(fn){
		queuePromise
			.then(function(chan){
				if (!chan) {
					_log('warn', `missing channel for queue ${name} not consuming`);
					return false;
				}

				if (closing) {
					_log('warn', `channel for queue ${name} was closed before we could start consuming`, 'HEY');
					return false;
				}

				return chan.consume(name, function(msg) {
					if (!msg){
						// this means the queue has been cancelled.
						return false;
					}

					if (closing) {
						_log('warn', `channel for queue ${name} was closed before we could ACK` );
						return false;
					}
					var myMessage;
					try {
						myMessage = JSON.parse(msg.content.toString());

						if (msg.properties){
							if (msg.properties.replyTo) myMessage._replyTo = msg.properties.replyTo;
							if (msg.properties.correlationId) myMessage._correlationId = msg.properties.correlationId;
						}

						if (msg.fields) {
							if (msg.fields.exchange) {
								myMessage._exchange = msg.fields.exchange;
							}

							const { routingKey } = msg.fields;
							// there are potentially many matches, but we just use the first one. meh.
							const matchedBinding = _.find(labeledBindings, b => b.isMatch && b.isMatch(routingKey));
							if (matchedBinding) {
								myMessage._label = matchedBinding.label;
							}
						}
					} catch (err){
						_log('error', 'error deserializing message', err);
						myMessage = {};
					}

					var doneCalled = false;
					var done = function(error){
						if (noAck) return;

						doneCalled = true;

						if (!error) {
							return chan.ack(msg);
						}

						myMessage._error = _.extend({}, {message: error.message, stack: error.stack}, error);

						var pushToRetryQueue = false;
						var retryDelay = 250;

						try {
							if (attempts) {
								myMessage._attempt = myMessage._attempt || 0;

								var maxAttempts;

								if (_.isArray(attempts)) {
									maxAttempts = _.size(attempts) + 1;
									retryDelay = attempts[myMessage._attempt];
								} else {
									maxAttempts = +attempts || 2;
								}

								myMessage._attempt += 1;

								if (myMessage._attempt < maxAttempts) {
									pushToRetryQueue = true;
								}
							}
						} catch (err) {
							console.error(err);
						}

						if (pushToRetryQueue) {
							return defaultExchangePublish(connString, myMessage, { delay: retryDelay, key: name })
								.then(function(){
									return chan.ack(msg);
								});
						} else if (useErrorQueue) {
							var options = {
								key: errorQueueName,
								persistent: true,
							};

							return defaultExchangePublish(connString, myMessage, options)
								.then(function(){
									return chan.ack(msg);
								})
								.catch(function(publishError){
									console.error(error);
									console.error(publishError);
								});
						} else {
							console.log('bad ack', error);
							return Promise.resolve(false);
						}
					};

					try {
						const myDone = (...args) => {
							// generous timeouts and then restart the whole thing.
							// TODO: try to reconnect instead of exiting
							Promise.resolve(done.apply(null, args))
								.timeout(60000)
								.catch(err => {
									console.error('our ack failed', err);
									return chan.nack(msg)
										.timeout(60000)
										.catch(err => {
											console.error('our ack failed, then our nack failed', err);
											process.exit(1);
										});
								});
						};

						fn(myMessage, myDone);
					} catch (e){
						if (!doneCalled){
							done(e.toString());
						}
					}
				}, { noAck: noAck });
			})
			.then(function(res){
				ctag = res.consumerTag;
			})
			.catch(function(err){
				console.log('there was a problem create queue: ' + name);
				console.error(err);
			});
	};

	receiveFunc.stop = function(){
		return queuePromise
			.then(function(chan){
				if (!ctag) return false;

				return chan.cancel(ctag);
			});
	};

	receiveFunc.close = function(){
		closing = true;

		return queuePromise
			.then(function(chan){
				return chan.close();
			});
	};

	receiveFunc.destroy = function(){
		closing = true;

		return queuePromise
			.then(function(chan){
				return chan.deleteQueue(name)
					.then(_.constant(chan))
					.catch(err => {
						_log(`error`, `unable to delete queue ${name}`, err);
						return chan;
					});
			})
			.then(function(chan){
				return chan.close();
			});
	};

	receiveFunc.addBinding = function(binding){
		return queuePromise
			.then(function(chan){
				if (closing) {
					return false;
				}

				if (binding.label && binding.key) {
					binding.isMatch = _patternToMatcher(binding.key);
					labeledBindings.push(binding);
				}

				return chan.bindQueue(name, binding.name, binding.key);
			});
	};

	receiveFunc.removeBinding = function(binding){
		return queuePromise
			.then(function(chan){
				return chan.unbindQueue(name, binding.name, binding.key);
			})
			.then(result => {
				if (binding.label) {
					_.pull(labeledBindings, b => b.label == binding.label);
				}

				return result;
			});
	};

	var property = Object.defineProperty.bind(Object, receiveFunc);
	property('ready', {
		get: function(){ return queuePromise; }
	});
	property('started', {
		get: function(){ return queuePromise; }
	});

	return receiveFunc;
}

module.exports = function (opt = {}) {
	return _.partial(Queue, opt.connString);
}
