var request = require('./request')(),
	Promise  = require('bluebird'),
	_  = require('lodash'),
	Queue = require('./queue')(),
	response = require('./response')(),
	ezuuid = require('ezuuid'),
	expect = require('chai').expect;

describe('rpc', function(){
	it.only('should be able to make rpc calls', function(done){
		this.timeout(4000);

		var METHOD_NAME = ezuuid();
		var listen = response(METHOD_NAME, { appName: 'test1' });
		var key = ezuuid();



		listen(function(err, req, cb){
			cb(null, { isResponse: true, msg:req.msg+ '_' + key});
		});

		listen.ready
			.then(function(){
				console.log('listen ready');
				return _.chain(_.range(6))
					.map(function(d, i){
						return new Promise(function(resolve, reject){
							request(METHOD_NAME)({msg: i}, function(err, res){
								console.log(err, res);
								if (err) return reject(err);

								var expected = i + '_'+key;
								expect(res.msg).to.be.equal(expected);
								resolve();
							});
						});
					})
					.thru(Promise.all)
					.value()
					.then(function(){
						done();
					});
			})
			.catch(done);
	});

	it('should handle timeouts', function(done){
		this.timeout(4000);

		var METHOD_NAME = 'this_is_my_timeout_Test';
		var listen = response(METHOD_NAME, { appName: 'whatever' });


		listen(function(err, req, cb){
			console.log('i just don\'t care');
		});

		request(METHOD_NAME)({msg: 'goodbye cruel world'}, function(err, res){
			console.error(err);
			console.dir(res);
			if (err) done();
		});
	});

	it('should handle trees in the forest type of thing', function(done){
		this.timeout(60000);

		var METHOD_NAME = 'beaches_do_not_exist';

		request(METHOD_NAME, {timeout:2000})({msg: 'goodbye cruel world'}, function(err, res){
			if (err) return done();

			done(new Error('there was no error is the error'));
		});
	});

	it('should expire messages properly', function(done){
		this.timeout(10000);

		var METHOD_NAME= 'this_is_my_ttl_test';
		var listen = response({methodName: METHOD_NAME, appName: 'great_app2', ttl: 2000});

		request({methodName: METHOD_NAME, timeout: 5000})({code: 'a'}, function(err, res){
			if (err && /timeout/i.test(err.message)) return done();
			done(err || new Error('there was a response'));
		});

		setTimeout(function(){
			listen(function(err, req, cb){
				cb(null, {message: 'hello'});
			});
		}, 3000);
	});
	it('should not expire delayed messages if within timeout', function(done){
		this.timeout(10000);

		var METHOD_NAME= 'this_is_my_other_ttl_test';
		var listen = response({methodName: METHOD_NAME, appName: 'testing_my_app', ttl: 3000});

		listen
			.ready
			.then(function(){
				request({methodName: METHOD_NAME, timeout: 4000})({code: 'a'}, function(err, res){
					if (err) return done(err);

					if (res.message === 'hello2')
						done();
				});

				setTimeout(function(){
					listen(function(err, req, cb){
						cb(null, {message: 'hello2'});
					});
				}, 2000);
			});

	});

	it('should be able to round robin requests if set as shared', function(done){
		this.timeout(40000);

		var METHOD_NAME= ezuuid();
		var listen1 = response({methodName: METHOD_NAME, appName: 'test', ttl: 3000, shared: true});
		var listen2 = response({methodName: METHOD_NAME, appName: 'test', ttl: 3000, shared: true});
		var listen3 = response({methodName: METHOD_NAME, appName: 'test', ttl: 3000, shared: true});

		Promise.all([listen1.ready,listen2.ready,listen3.ready])
			.then(function(){
				return new Promise(function(resolve){
					setTimeout(function(){
						resolve();
					}, 1000);
				});
			})
			.then(function(){
				request({appName: 'shared_test_', methodName: METHOD_NAME, timeout: 4000})({code: 'a'}, function(err, res){
					if (err) return done(err);
				});

				request({appName: 'shared_test_', methodName: METHOD_NAME, timeout: 4000})({code: 'b'}, function(err, res){
					if (err) return done(err);
				});

				request({appName: 'shared_test_', methodName: METHOD_NAME, timeout: 4000})({code: 'c'}, function(err, res){
					if (err) return done(err);
				});
			})
			.catch(function(err){
				done(err);
			});


		var heard1, heard2, heard3, isDone;
		function allDone(){
			if (isDone) return;

			if (heard1 && heard2 && heard3) {
				console.log('success');
				isDone = true;
				done();
			}
		}

		listen1(function(err, req, cb){
			console.log('listen1: ' + req.code);
			if (heard1) return done(new Error('already heard1'));
			heard1 = true;
			cb(null, {message: 'hello1'});
			allDone();
		});
		listen2(function(err, req, cb){
			console.log('listen2: ' + req.code);
			if (heard2) return done(new Error('already heard2'));
			heard2 = true;
			cb(null, {message: 'hello2'});
			allDone();
		});
		listen3(function(err, req, cb){
			console.log('listen3: ' + req.code);
			if (heard3) return done(new Error('already heard3'));
			heard3 = true;
			cb(null, {message: 'hello3'});
			allDone();
		});
	});

	it('should return errors properly', function(done){
		this.timeout(5000);

		var METHOD_NAME= ezuuid();
		var listen = response({methodName: METHOD_NAME, appName: 'test', ttl: 3000, shared: true});

		listen(function(err, req, cb){
			cb(new Error('this is an error'));
		});

		listen.ready
			.then(function(){
				request({ methodName: METHOD_NAME, timeout: 4000})({code: 'a'}, function(err, res){
					if (err) {
						done();
					}
				});
			})
			.catch(function(err){
				done(err);
			});

	});
});
