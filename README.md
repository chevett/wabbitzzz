wabbitzzz  [![Build Status](https://build.deliveryrelay.com/chevett/wabbitzzz/badge)](https://build.deliveryrelay.com/chevett/wabbitzzz)
=========


Exchange
```js
var Exchange = require('wabbitzzz').Exchange;
var exchanage = new Exchange({
		name: 'this_is_a_cool_exchange'
	});

exchange.publish({hi: 'you'});

// publish the message, but have rabbit hold it for 3 seconds first
exchange.delayedPublish({bye: 'you'}, {delay:3000});
```

Queue
```js
var Queue = require('wabbitzzz').Queue;
var queue = new Queue({
		name: 'myQueue',
		exchangeNames:['this_is_a_cool_exchange'],
	});

queue(function(msg, ack){
	console.dir(msg);
	ack(); // pass something to ack for a failure
});
```


RPC Send
```js
var rpc = require('wabbitzzz').request('method-name');
rpc(req, function(err, res){

});
```

RPC Listen
```js
var rpc = require('wabbitzzz').response('method-name');
rpc(function(err, req, cb){

});
```

Policy
======
Do it like this.
```
Pattern	^(?!amq\.).*(?<!_rpc)$
Apply to	all
Definition	
ha-mode:	all
ha-sync-mode:	manual
Priority	-101
```
