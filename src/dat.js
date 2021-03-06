import fs from 'fs-extra';
import path from 'path';
import EventEmitter from 'events';
import createDat from 'dat-node';
import { openCollections, createCollection } from 'dat-collections';
// import _ from 'lodash';
import Promise from 'bluebird';
import chalk from 'chalk';
import _ from 'lodash';
import messages from 'dat-protocol-buffers';
import { download, readdir, findEntryByContentBlock } from './utils/hyper';
// import prettysize from 'prettysize';

// declare common promisified function here
// so they will only be created once.
const createDatAsync = Promise.promisify(createDat);
const renameAsync = Promise.promisify(fs.rename);

function iteratePromised(co, fn) {
  const runner = () => {
    const v = co.next();
    if (v.done) return 'ok';
    return Promise.resolve(v.value).then(fn).then(runner);
  };
  return runner();
}

// import { lsFilesPromised } from './utils/filesystem';

// fork() - download a dat and fork it (thru dat.json)
// list() - lists files
// download() - downloads some files
// read/writeManifest()
// health/ stats

/**
 * Adds Library-ish functions to a Dat. Expects the Dat's directory structure to
 * follow Calibre's (Author Name/ Publication Title/ Files)
 */
export default class DatWrapper extends EventEmitter {
  constructor(opts) {
    super();
    this.directory = opts.directory;
    this.metadataDownloadCount = 0;
    this.filesCount = false;
    this.metadataComplete = false;
    this.listeningToDownloads = false;
    this.importingFiles = false;
    // There might be several path formats within a dat. This keeps track of the numbers.
    this.format = undefined;
    this.formatCounts = {};
    // create if it doesn't exist
    if (!fs.existsSync(opts.directory)) {
      fs.mkdirSync(opts.directory);
    }
    this.key = opts.key;
    this.name = opts.name;
    this.stats = false;
    this.opts = opts;
    // Don't need the whole history (also we do need files as files)
    this.opts.latest = true;
    // If we're creating/ hosting a dat, set indexing to true
    // this.opts.indexing = !this.key;
    this.opts.indexing = true;
    this.importer = false;
    // Collections
    this.availableCollections = false;
  }

  // Just creates a dat object
  create() {
    return createDatAsync(this.directory, this.opts)
      .then((dat) => {
        this.dat = dat;
        this.key = dat.key.toString('hex');
        this.metadataDownloadCount = dat.archive.metadata.downloaded();
        this.metadataComplete = this.metadataDownloadCount === (this.version + 1);
        // console.log('created dat:', this.key);
        // console.log('metadata:', this.metadataDownloadCount, '/', this.version, this.metadataComplete);
        return this;
      });
  }

  // join network and import files
  run() {
    this.importFiles();

    const network = this.dat.joinNetwork();
    network.once('connection', this.connectionEventHandler);

    // Watch for metadata syncing
    const metadata = this.dat.archive.metadata;
    metadata.on('download', this.metadataDownloadEventHandler);
    metadata.on('sync', this.metadataSyncEventHandler);
    metadata.download(); // always download metadata

    // Watch for content downloading
    this.dat.archive.on('content', () => {
      const content = this.dat.archive.content;
      content.on('download', this.contentDownloadEventHandler);
      this.listeningToDownloads = true;
    });
    return this;
  }

  connectionEventHandler = () => {
    // console.log('connects via network');
    this.stats = this.dat.trackStats();
    console.log(chalk.gray(chalk.bold('peers:')), this.stats.peers);
  }

  // @TODO: This will be an inefficient thing to do in large archives. Rethink!
  contentDownloadEventHandler = (index) => {
    this.contentDownloadCount++;
    findEntryByContentBlock(this.dat.archive, index)
      .then((data) => {
        const got = this.dat.archive.content.downloaded(data.start, data.end) + 1;
        const tot = (data.end - data.start) + 1;
        const progress = (got / tot) * 100;
        this.emit('download content', {
          key: this.key,
          file: data.name,
          progress,
        });
      });
  }

  metadataDownloadEventHandler = (index, data) => {
    this.metadataDownloadCount++;
    if (index === 0) {
      const header = messages.Header.decode(data);
      if (header.type !== 'hyperdrive') console.warn('dat header is not a hyperdrive:', header.type);
    } else {
      const block = messages.Node.decode(data);
      const progress = this.version > 0 ? (this.metadataDownloadCount / (this.version + 1)) * 100 : 0;
      this.emit('download metadata', {
        key: this.key,
        version: index,
        type: block.value ? 'put' : 'del',
        progress,
        file: block.path,
        stats: block.value,
        downloadSpeed: this.stats.network.downloadSpeed,
        uploadSpeed: this.stats.network.uploadSpeed,
        peers: this.stats.peers.total || 0,
      });
      // console.log(`downloaded ${index}/${dat.archive.version + 1}:`, block.path);
      // console.log(`network: ${this.stats.peers.total || 0} peers (${prettysize(this.stats.network.downloadSpeed)}) ${progress.toFixed(2)}% complete`);
    }
  }

  metadataSyncEventHandler = () => {
    console.log('metadata synced');
    this.metadataComplete = true;
    this.emit('sync metadata', this.key);
  };

  // call a function on each downloaded chuck of metadata.
  onEachMetadata(fn, startingFrom) {
    // returns a promise which will succeed if all are successful or fail and stop iterator.
    return iteratePromised(this.metadataIterator(startingFrom), fn);
  }

  // this should iterate over only the downloaded metadata,
  // we can use this to populate database before joining the swarm
  // only importing what has already been downloaded, and then
  // fetch the rest via the 'metadata' downloaded events.
  * metadataIterator(start = 1) {
    const metadata = this.dat.archive.metadata;
    let imported = start;
    const total = metadata.downloaded();
    // this can be improved by using the bitfield in hypercore to find next non 0 block, but will do for now.
    for (let i = start; i <= this.version; i++) {
      if (metadata.has(i)) {
        yield new Promise((resolve, reject) => // fix this to not make functions in a loop.
          metadata.get(i, (error, result) => {
            if (error) reject(error);
            else {
              imported += 1;
              const progress = total > 0 ? (imported / total) * 100 : 0;
              const node = messages.Node.decode(result);
              resolve({
                version: i,
                key: this.key,
                progress,
                type: node.value ? 'put' : 'del',
                file: node.path,
                stats: node.value,
              });
            }
          }),
        );
      }
    }
  }

  isYours() {
    return this.dat.writable;
  }

  get byteLength() {
    if (this.dat.archive.content) {
      if (this.dat.archive.content.byteLength === 0) {
        this.dat.archive.content.update();
      }
      return this.dat.archive.content.byteLength;
    }
    return 0;
  }

  get moreStats() {
    const network = this.stats && this.stats.network;
    const metadataProgress = this.version > 0 ? (this.metadataDownloadCount / (this.version + 1)) * 100 : 0;
    return {
      peers: this.peers,
      size: this.byteLength,
      filesCount: this.filesCount,
      metadata: (this.importingFiles === false) ? metadataProgress : this.importingFiles,
      downloaded: (this.filesCount && this.filesCount.total)
        ? (this.filesCount.have / this.filesCount.total) * 100
        : 0,
      downloadSpeed: network ? network.downloadSpeed : 0,
      uploadSpeed: network ? network.uploadSpeed : 0,
    };
  }

  // How many peers for this dat
  get peers() {
    return this.stats.peers || { total: 0, complete: 0 };
  }

  get version() {
    return this.dat.archive.version;
  }

  // Add some data to the path formats
  incrementPathFormat(format) {
    if (_.has(this.formatCounts, format)) {
      this.formatCounts[format]++;
    } else {
      this.formatCounts[format] = 1;
    }
    this.format = _.maxBy(_.keys(this.formatCounts), o => this.formatCounts[o]);
  }

  incrementFilesCount(incrementTotal) {
    if (incrementTotal) {
      this.filesCount.total += 1;
    } else {
      this.filesCount.have += 1;
    }
  }

  setFilesCount(have, total) {
    this.filesCount = { have, total };
  }

  importFiles(importPath = this.directory) {
    return new Promise((resolve, reject) => {
      if (this.isYours()) {
        console.log('Importing files under:', importPath);
        this.importingFiles = 0;
        let putTotal = 0;
        let putCount = 0;
        const opts = {
          watch: false, // if watch is true imported is never fired
          count: true,
          dereference: true,
          indexing: true,
          live: true,
        };
        this.importer = this.dat.importFiles(importPath, opts, () => {
          console.log(`Finished importing files in ${importPath}`);
          this.emit('imported', {
            key: this.key,
            path: importPath,
          });
          this.importingFiles = false;
          this.metadataDownloadCount = this.dat.archive.metadata.downloaded();
          resolve(true);
        });
        this.importer.on('count', (count) => {
          // file count is actually just a put count
          // this could funk out on dat's with lots of dels.
          putTotal = count.files;
        });
        this.importer.on('error', reject);
        // Emit event that something has been imported into the dat
        this.importer.on('put', (src) => {
          putCount += 1;
          this.importingFiles = putTotal > 0 ? (putCount / putTotal) * 100 : 0;
          const data = {
            type: 'put',
            key: this.key,
            file: src.name.replace(this.directory, ''),
            stat: src.stat,
            progress: this.importingFiles,
            version: this.version, // I am not sure if this works as version is not set by mirror-folder
          };
          this.emit('import', data);
        });
        this.importer.on('del', (src) => {
          this.importingFiles = putTotal > 0 ? (putCount / putTotal) * 100 : 100;
          const data = {
            type: 'del',
            key: this.key,
            file: src.name.replace(this.directory, ''),
            stat: src.stat,
            progress: this.importingFiles,
            version: this.version,
          };
          this.emit('import', data);
        });
        resolve(this.importer);
      } else {
        resolve(false);
      }
    });
  }

  // Import a file or directory from another archive
  async importFromDat(srcDatWrapper, fileOrDir, overwriteExisting = true) {
    /*
    if (this.isYours()) {
      const dstPath = path.join(this.directory, fileOrDir);
      return pda.exportArchiveToFilesystem({
        srcArchive: srcDatWrapper.dat.archive,
        dstPath,
        srcPath: fileOrDir,
        overwriteExisting,
      });
      // .then(() => this.importFiles());
    }
    console.log('Warning: You tried to write to a Dat that is not yours. Nothing has been written.');
    // Fallback
    */
    // @TODO: Move our own implementation to hyper.js
    return Promise.resolve(false);
  }

  // Lists the contents of the dat
  listContents(below = '/') {
    return readdir(this.dat.archive, below, { recursive: true });
  }

  // Download a file or directory
  downloadContent(fn = '') {
    const filename = (fn === '') ? '/' : `/${fn}`;
    console.log(`Downloading: ${filename}`);
    console.log(this.stats.peers);
    // Start download process
    // Don't use recursion if we don't have to (i.e. if we're getting everything)
    if (fn === '') {
      this.dat.archive.download();
    } else {
      download(this.dat.archive, filename);
    }
    if (!this.listeningToDownloads) {
      this.dat.archive.content.on('download', this.contentDownloadEventHandler);
      this.listeningToDownloads = true;
    }
    return Promise.resolve(true);
  }

  // Has the file been downloaded?
  hasFile = file => new Promise(r => fs.access(path.join(this.directory, file), fs.F_OK, e => r(!e)))

  // Rename
  rename(dir, name) {
    return renameAsync(this.directory, dir)
      .then(() => {
        this.directory = dir;
        this.name = name;
      });
  }

  // Returns a list of the collections available through this dat
  getAvailableCollections() {
    if (this.availableCollections) {
      return this.availableCollections.list()
      .catch(() => []);
    }
    return openCollections(this.dat.archive, 'dat-collections')
    .tap((colls) => { this.availableCollections = colls; })
    .then(colls => colls.list())
    .catch(() => []);
  }

  // Loads a single collection and returns a list of its flattened contents
  loadCollection(name) {
    return createCollection(this.dat.archive, path.join('dat-collections', name))
    .then(collection => collection.flatten())
    .catch(() => []);
  }

  // Returns a {title, description} object for information about a collection.
  // path is an array, potentially describing a subcollection
  informationAboutCollection(name, subcoll) {
    const info = { title: '', description: '' };
    return createCollection(this.dat.archive, path.join('dat-collections', name))
    .then(collection =>
      collection.title(subcoll).then((s) => { info.title = s; })
      .then(collection.description(subcoll).then((s) => { info.description = s; })))
    .then(() => info)
    .catch(() => info);
  }

  // Copies a file into a dat
  copyFile(pathInDat, fileToCopy) {
    const destPath = path.format({
      dir: this.directory,
      base: pathInDat,
    });
    return Promise.resolve()
    .then(() => fs.copy(fileToCopy, destPath))
    .catch((err) => {
      console.error(err);
    });
  }

  // Writes a string `content` to a file at `filePath`
  writeFile(pathInDat, content) {
    const destPath = path.format({
      dir: this.directory,
      base: pathInDat,
    });
    return Promise.resolve()
      .then(() => fs.ensureDir(path.dirname(destPath)))
      .then(() => fs.writeFile(destPath, content))
      .catch((err) => {
        console.error(err);
      });
  }

  // Updates a file
  updateFile(pathInDat, content) {
    const destPath = path.format({
      dir: this.directory,
      base: pathInDat,
    });
    return Promise.resolve()
      .then(() => fs.writeFile(destPath, content))
      .catch((err) => {
        console.error(err);
      });
  }

  // Write a manifest file
  writeManifest(opts = {}) {
    const manifest = {
      url: `dat://${this.key}`,
      title: this.name,
      ...opts,
    };
    return this.writeFile('dat.json', JSON.stringify(manifest));
  }

  // Read a manifest file
  readManifest(filePath = 'dat.json') {
    const hyperdriveReadFile = Promise.promisify(
      this.dat.archive.readFile,
      { context: this.dat.archive });
    return hyperdriveReadFile(filePath)
      .then(s => JSON.parse(s))
      .catch((err) => {
        console.error(err);
        return {};
      });
  }

  // manifest JSON is written to the manifest file.
  updateManifest(manifest) {
    return this.updateFile('dat.json', JSON.stringify(manifest));
  }

  close() {
    return new Promise((resolve, reject) => this.dat.close((err) => {
      if (err) reject(err);
      else resolve();
    }));
  }
}
