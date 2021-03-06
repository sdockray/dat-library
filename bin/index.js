#!/usr/bin/env node
const pkg = require('../package.json');
const cmd = require('commander');

cmd
  .version(pkg.version)
  .command('run', 'run the card catalogue', { isDefault: true })
  .command('import-cat [key] [name]', 'import cardcat with "key" giving it a readable "name"')
  .command('create-cat [dir] [name]', 'create cardcat from a "dir" giving it a readable "name"')
  .command('add-file [file] [key] [author] [title]', 'add a "file" to cardcat "key" with an "author" and "title"')
  .command('add-text [text] [key] [author] [title]', 'add a string "text" to cardcat "key" with an "author" and "title"')
  .command('fork-cat [keyFork] [name]', 'fork a cardcat and give it a readable "name"')
  .command('health [key]', 'check on the health of a cardcat by "key"')
  .command('checkout [author] [title] [file]', 'checkout a text')
  .command('author [command]', 'author commands')
  .command('collection [command]', 'collection commands')
  .command('search [query]', 'search the cardcat')
  .command('copy [keyFrom] [keyTo] [resource]', 'copy something from one dat to another')
  .parse(process.argv);
