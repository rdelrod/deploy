/**
 * ExpressJS + Socket.io methods.
 **/

'use strict';

const express = require('express');
const log     = require('./log.js');

const config  = require('../config/config.json');

const app     = express();

// Setup the REST API
app.get('/', function(req, res) {
  return res.send({
    success: false,
    reason: 'NOTFOUND'
  });
});

/**
 * /status
 *
 * Get The Deployment status
 **/
app.get('/status', function(req, res) {
  return res.send({
    status: global.status
  });
});

// Inject Socket.io for realtime updates.
let server = require('http').createServer(app);
server.path= config.socket.path || '/realtime';

let io = require('socket.io')(server);
io.on('connection', function() {
  log('socket', 'recieved a connection')
});


server.listen(config.express.port);

module.exports = io;
