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
io.sockets.on('connection', function (socket) {
    console.log('Client connected from: ' + socket.handshake.address.address);

    log('socket', 'emitted connected event');
    socket.emit('connected');

    socket.on('disconnect', function() {
      log('socket', socket.handshake.address.address, 'disconnected');
    });
});



server.listen(config.express.port);

module.exports = io;
