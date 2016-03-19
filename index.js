/**
 * deploy - a deployment server utilizing Github web hooks to deploy code.
 *
 * @author Jared Allard <jaredallard@outlook.com>
 * @license MIT
 * @version 1.0.0
 **/

const express = require('express'),
      github  = require('githubhook');

// our libraries.
const log     = require('./lib/log.js');
const slog    = function() {
  const args = Array.prototype.slice.call(arguments, 0);
  args.unshift('deploy');
  log.apply(log, args);
}

const config  = require('./config/config.json');

// instance our APIs
const app     = new express();
const hook    = github(config.githubhook);

// trigger on push event.
hook.on('push', function (repo, ref, data) {
  log('githubhook', 'Got push event');
  console.log(repo);
  console.log(ref);
  console.log(data);
});

// Start the Github Event Listener.
hook.listen();

slog('initialized')
