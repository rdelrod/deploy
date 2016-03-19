'use strict';

/**
 * Logs data, in brackets, to console.
 *
 * @param {any} arguments - Text to output.
 * @return {undefined} nothing
 **/
let log = function() {
  const args = Array.prototype.slice.call(arguments, 0);
  let level = args.shift();

  // use the brackets.
  level = '['+level+']';

  args.unshift(level);

  console.log.apply(console, args);
}

// export the log function, for require()
module.exports = log;
