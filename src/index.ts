import fs from 'fs';
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command, HeadObjectCommand, PutObjectCommandInput, ObjectCannedACL } from "@aws-sdk/client-s3";

import mimetypes from 'mime-types';
import os from 'os';
import Debug from 'debug';
import PQueue from 'p-queue';
import { FileTypeResult } from 'file-type';
import { String } from 'aws-sdk/clients/batch';
import { Readable } from 'stream';


const debug = Debug('s3driver');

let 
	fileTypeFromFile: ((filePath: string) => Promise<FileTypeResult | undefined>) | undefined, 
	PQueueClass: PQueue | null = null;

import('file-type').then((fileTypeModule) => {
	fileTypeFromFile = fileTypeModule.fileTypeFromFile;
});

export interface S3Config {
    accessKeyId: string;
    secretAccessKey: string;
    endpoint?: string;
    bucket: string;
}

export interface TransferParams {
    acl?: ObjectCannedACL;
    overwrite?: boolean;
    overwrite_if_newer?: boolean;
    dirs_concurrency?: number;
    files_concurrency?: number;
}

export interface ListParams {
    Bucket: string,
    Delimiter: string,
    Prefix: string,
    MaxKeys?: number,
}

export interface DirectoryItem {
    is_dir: boolean;
    name: string;
    mtime?: Date; // doesnt exists for dirs
    size?: number; // doesnt exists for dirs
}

export interface S3Driver {
    s3: S3Client | null;
    bucket: string | null;

    dirs_concurrency: number;
    files_concurrency: number;
    queue_dirs: null | PQueue;
    queue_files: null | PQueue;
    queue: null | PQueue;

    config: (config: S3Config) => void,
}


export default class s3driver implements S3Driver {
	s3: S3Client | null = null;
	bucket: string = '';

	dirs_concurrency: number = 15; // default
	files_concurrency: number = 50; // default
	queue_dirs: null | PQueue = null;
	queue_files: null | PQueue = null;
	queue: null | PQueue = null; // old uploadDir2

	constructor() {
		(async () => {
			//PQueueClass = (await import('p-queue')).default;
		})();
	}

	/**
	 * Configures the S3 driver with the provided configuration.
	 * @param {Object} config - S3 configuration object.
	 */
	config(config: S3Config) {
		this.s3 = new S3Client({
			...config,
			credentials: {
				accessKeyId: config.accessKeyId,
				secretAccessKey: config.secretAccessKey,
			},
			...(config.endpoint && {
				endpoint: config.endpoint.startsWith("https://") || config.endpoint.startsWith("http://")
				  ? config.endpoint
				  : `https://${config.endpoint}`
			})
		});
		this.bucket = config.bucket;
	}

  	/**
	 * Uploads a directory to S3, including subdirectories and files, skips empty dirs
	 * @param {string} dir - Local directory path to upload.
	 * @param {string} [prefix=''] - Prefix to add to S3 object keys.
	 * @param {Object} [params={}] - Additional parameters for customization.
	 * @param {string} [params.acl=public-read] - Access control list. Default is "public-read."
	 * @param {boolean} [params.overwrite=false] - Whether to overwrite existing items. Default is "false"
	 * @param {boolean} [params.overwrite_if_newer=false] - Overwrite only if the source is newer. Default is "false"
	 * @param {number} [params.dirs_concurrency] - Number of concurrent directories operations.
	 * @param {number} [params.files_concurrency] - Number of concurrent files operations.
	 * @returns {Promise<boolean>} - A promise resolving to true if the upload is successful.
	 */
	async uploadDir(dir: string, prefix: string = '', params: TransferParams = {}): Promise<boolean> {
		debug('uploadDir', dir, prefix);

		/*
		if ('undefined' === typeof PQueueClass) {
			PQueueClass = (await import('p-queue')).default;
		}*/

		let
			overwrite = false,
			overwrite_if_newer = false,
			acl: ObjectCannedACL = 'public-read';

		if ('acl' in params && params.acl) {
			acl = params.acl;
		}
		if ('overwrite' in params && params.overwrite) {
			overwrite = true;
		}
		if ('overwrite_if_newer' in params && params.overwrite_if_newer) {
			overwrite = true;
			overwrite_if_newer = true;
		}

		// making sure queues initiated (or settings passed about changing concurrecy, so we reinitiate queues)
		if (null === this.queue_dirs || 'dirs_concurrency' in params) {
			this.queue_dirs = new PQueue({concurrency: ('dirs_concurrency' in params) ? params.dirs_concurrency : this.dirs_concurrency});
			delete params.dirs_concurrency;
		}
		if (null === this.queue_files || 'files_concurrency' in params) {
			this.queue_files = new PQueue({concurrency: ('files_concurrency' in params) ? params.files_concurrency : this.files_concurrency});
			delete params.files_concurrency;
		}

		// adding trailing slash to add deeper path in the future
		if (!dir.endsWith('/')) dir += '/';
		// removing first slash, if exists
		prefix = prefix.replace(/^\//, '');

		let files_remote = await this.list(prefix, true) as DirectoryItem[] ;
		let files = fs.readdirSync(dir, { withFileTypes: true });
		debug('files to upload:', files);

		//console.log(files_remote);
		//console.log('filling files/dir queue');
		for (let file of files) {

			if (file.isDirectory()) {
				//console.log('uploadDir', dir, file.name, prefix, file.name);

				await this.queue_dirs.add(() => {
					return this.uploadDir(dir + file.name, prefix + file.name + '/', params);
				}, {priority : 0});

			} else {

				// searching for remote file in array
				let file_remote = files_remote.find(obj => {
				 	return file.name === obj.name
				});

				if (overwrite || undefined === file_remote) { // !files_remote.includes(file.name)

					let upload_or_not = true;

					if (overwrite_if_newer) {
						upload_or_not = false;
						let stats = fs.statSync(dir + file.name);
						//console.log(stats);

						if (undefined === file_remote || (file_remote.mtime && new Date(stats.mtime) > new Date(file_remote.mtime))) {
							console.log('MODIFIED!', file.name);
							upload_or_not = true;
						}
					}

					//console.log('queue_files');
					if (upload_or_not)
						this.queue_files.add(async () => {
							//console.log('upload', dir + file.name, prefix + file.name);
							await this.upload(dir + file.name, prefix + file.name, acl);

							// if dir queue have been paused - unpausing if files queue became smaller
							if (this.queue_dirs!.isPaused && 3 * this.files_concurrency > this.queue_files!.size) {
								this.queue_dirs!.start();
								debug('UNpausing dir queue');
							}

						}, {priority : 1}); // maximum priority for file uploads
				}
			}
		}
		
		// if files queue 3 times bigger than in settings - pausing dirs queue so it wont eat too much memory
		debug('queue_files.size', this.queue_files.size);
		if (3 * this.files_concurrency < this.queue_files.size) {
			this.queue_dirs.pause();
			debug('Pausing dir queue');
		}

		//console.log('AFTER FOR queue_files.size', this.queue_files.size);
		// Wait for both promises to resolve
		return Promise.all([this.queue_dirs.onIdle(), this.queue_files.onIdle()])
			.then(() => {
				// Both queues have finished their tasks
				debug("Both dir and files queus are finished.");
				return true;
			})
			.catch((error) => {
				// Handle errors if any of the promises reject
				console.error("Error while waiting for queues to finish:", error);
				return false;
			});
	}

	/**
	 * Uploads a directory from a cloud to cloud (using current temp dir as intermediary), skips empty dirs
	 * @param {Object} CONF - Configuration for the another S3 connection.
	 * @param {string} dir - Local directory path to upload.
	 * @param {string} [prefix=''] - Prefix to add to S3 object keys.
	 * @param {Object} [params={}] - Additional parameters for customization.
	 * @param {string} [params.acl=public-read] - Access control list. Default is "public-read."
	 * @param {boolean} [params.overwrite=false] - Whether to overwrite existing items. Default is "false"
	 * @param {boolean} [params.overwrite_if_newer=false] - Overwrite only if the source is newer. Default is "false"
	 * @param {number} [params.dirs_concurrency] - Number of concurrent directories operations.
	 * @param {number} [params.files_concurrency] - Number of concurrent files operations.
	 * @returns {Promise<boolean>} - A promise resolving to true if the upload is successful.
	 */
	async uploadDirCloud(CONF: S3Config, dir: string, prefix: string = '', params: TransferParams = {}) {
		debug('uploadDir', dir, prefix);

		/*
		if ('undefined' === typeof PQueueClass) {
			PQueueClass = (await import('p-queue')).default;
		}*/

		const remote_from = new s3driver;
		remote_from.config(CONF);
		//await remote_from.download('/fc42b21790b0dd77e26b.js', '/var/folders/rr/q_0tgkkn4299bwpz8xsl17m00000gn/T/fc42b21790b0dd77e26b.js');
		//console.log(remote_from);

		let
			overwrite = false,
			overwrite_if_newer = false,
			acl: ObjectCannedACL = 'public-read';

		if ('acl' in params && params.acl) {
			acl = params.acl;
		}
		if ('overwrite' in params && params.overwrite) {
			overwrite = true;
		}
		if ('overwrite_if_newer' in params && params.overwrite_if_newer) {
			overwrite = true;
			overwrite_if_newer = true;
		}

		// making sure queues initiated (or settings passed about changing concurrecy, so we reinitiate queues)
		if (null === this.queue_dirs || 'dirs_concurrency' in params) {
			this.queue_dirs = new PQueue({concurrency: ('dirs_concurrency' in params) ? params.dirs_concurrency : this.dirs_concurrency});
			delete params.dirs_concurrency;
		}
		if (null === this.queue_files || 'files_concurrency' in params) {
			this.queue_files = new PQueue({concurrency: ('files_concurrency' in params) ? params.files_concurrency : this.files_concurrency});
			delete params.files_concurrency;
		}

		//for (let i = 0; i <= 20; i++) this.upload('./test-files/test copy 85.js', 'lambda8/test copy 85.js').then(console.log); return;

		// adding trailing slash to add deeper path in the future
		if (!dir.endsWith('/') && '' != dir) dir += '/';
		// Removing the first slash, if it exists
		prefix = prefix.replace(/^\//, '');

		let files_remote = await this.list(prefix, true) as DirectoryItem[];
		//let files = fs.readdirSync(dir, { withFileTypes: true });
		let files = await remote_from.list(dir, true) as DirectoryItem[];
		debug('files_remote', files_remote);

		//console.log(files_remote);
		//console.log('filling files/dir queue');
		for (let file of files) {

			if (file.is_dir) {
				//console.log('uploadDir', dir, file.name, prefix, file.name);
				this.queue_dirs!.add(() => {
					return this.uploadDirCloud(CONF, dir + file.name, prefix + file.name + '/', params);
				}, {priority : 0});

			} else {

				// Searching for remote file in array
				let file_remote = files_remote.find(obj => {
				 	return file.name === obj.name
				});

				if (overwrite || undefined === file_remote) { // !files_remote.includes(file.name)

					let upload_or_not = true;

					if (overwrite_if_newer) {
						upload_or_not = false;
						//let stats = fs.statSync(dir + file.name);
						//console.log(stats);
						debug('file_remote', file_remote);
						if (undefined === file_remote || (file.mtime && file_remote.mtime && new Date(file.mtime) > new Date(file_remote.mtime))) {
							debug('MODIFIED!', file.name);
							upload_or_not = true;
						}
					}

					//console.log('queue_files');
					if (upload_or_not)
						this.queue_files!.add(async () => {
							debug('upload', dir + file.name, prefix + file.name);
							debug('download', dir + file.name, os.tmpdir() + '/' + file.name);

							await remote_from.download(dir + file.name, os.tmpdir() + '/' + file.name);

							if (!fs.existsSync(os.tmpdir() + '/' + file.name)) {
								throw new Error('NO FILE ' + dir + file.name + ' ' + os.tmpdir() + '/' + file.name);
							}
							debug('downloaded');

							await this.upload(os.tmpdir() + '/' + file.name, prefix + file.name, acl);
							debug('uploaded');
							fs.unlinkSync(os.tmpdir() + '/' + file.name);

							// if dir queue have been paused - unpausing if files queue became smaller
							if (this.queue_dirs!.isPaused && 3 * this.files_concurrency > this.queue_files!.size) {
								this.queue_dirs!.start();
								debug('UNpausing dir queue');
							}

						}, {priority : 1}); // maximum priority for file uploads
				}
			}
		}
		
		// If files queue 3 times bigger than in settings - pausing dirs queue so it wont eat too much memory
		debug('queue_files.size', this.queue_files!.size);
		if (3 * this.files_concurrency < this.queue_files!.size) {
			this.queue_dirs!.pause();
			debug('Pausing dir queue');
		}

		//console.log('AFTER FOR queue_files.size', this.queue_files.size);
		return true;
	}

	/**
	 * Downloads a directory from S3, including subdirectories and files, skips empty dirs
	 * Can handle subdirectories, overwrite existing files, and check for modifications
	 * @param {string} [prefix=''] - Prefix of S3 object keys to download.
	 * @param {string} dir - Local directory path to save downloaded files.
	 * @param {Object} [params={}] - Additional parameters for customization.
	 * @param {string} [params.acl=public-read] - Access control list. Default is "public-read."
	 * @param {boolean} [params.overwrite=false] - Whether to overwrite existing items. Default is "false"
	 * @param {boolean} [params.overwrite_if_newer=false] - Overwrite only if the source is newer. Default is "false"
	 * @param {number} [params.dirs_concurrency] - Number of concurrent directories operations.
	 * @param {number} [params.files_concurrency] - Number of concurrent files operations.
	 * @returns {Promise<boolean>} - A promise resolving to true if the download is successful.
	 */
	async downloadDir(prefix:string = '', dir: string, params: TransferParams = {}) {
		debug('downloadDir', dir, prefix);
		/*
		if ('undefined' === typeof PQueueClass) {
			PQueueClass = (await import('p-queue')).default;
		}
		*/

		fs.mkdirSync(dir, { recursive: true });

		let
			overwrite = false,
			overwrite_if_newer = false,
			acl = 'public-read';

		if ('acl' in params && params.acl) {
			acl = params.acl;
		}
		if ('overwrite' in params && params.overwrite) {
			overwrite = true;
		}
		if ('overwrite_if_newer' in params && params.overwrite_if_newer) {
			overwrite = true;
			overwrite_if_newer = true;
		}

		// Making sure queues initiated (or settings passed about changing concurrecy, so we reinitiate queues)
		if (null === this.queue_dirs || 'dirs_concurrency' in params) {
			this.queue_dirs = new PQueue({concurrency: ('dirs_concurrency' in params) ? params.dirs_concurrency : this.dirs_concurrency});
			delete params.dirs_concurrency;
		}
		if (null === this.queue_files || 'files_concurrency' in params) {
			this.queue_files = new PQueue({concurrency: ('files_concurrency' in params) ? params.files_concurrency : this.files_concurrency});
			delete params.files_concurrency;
		}

		// Adding trailing slash to add deeper path in the future
		if (!dir.endsWith('/') && '' != dir) dir += '/';
		// removing first slash, if exists
		prefix = prefix.replace(/^\//, '');

		let files = await this.list(prefix, true) as DirectoryItem[];

		//console.log(files_remote);
		//console.log('filling files/dir queue');
		for (let file of files) {

			if (file.is_dir) {
				//console.log('uploadDir', dir, file.name, prefix, file.name);

				this.queue_dirs.add(async () => {
					return this.downloadDir(prefix + file.name + '/', dir + file.name, params);
				}, {priority : 0});

			} else {
				let local_file_exists = fs.existsSync(dir + '/' + file.name);

				if (overwrite || !local_file_exists) { // !files_remote.includes(file.name)

					let upload_or_not = true;

					if (overwrite_if_newer) {
						upload_or_not = false;

						let stats;
						if (!local_file_exists) {
							stats = fs.statSync(dir + file.name);
						}
						//console.log(stats);

						if (!local_file_exists || (file.mtime && new Date(file.mtime) > new Date(stats!.mtime))) {
							debug('MODIFIED!', file.name);
							upload_or_not = true;
						}
					}

					debug('upload_or_not =', upload_or_not);
					if (upload_or_not)
						this.queue_files.add(async () => {
							//console.log(os.tmpdir());
							debug('download', prefix + '/' + file.name, dir + file.name);
							await this.download(prefix + '/' + file.name, dir + file.name);

							debug('File exists', dir + file.name, fs.existsSync(dir + file.name));
							if (!fs.existsSync(dir + file.name)) {
								throw new Error('NO FILE ' + prefix + file.name + ' ' + dir + '/' + file.name);
							}

							// if dir queue have been paused - unpausing if files queue became smaller
							if (this.queue_dirs!.isPaused && 3 * this.files_concurrency > this.queue_files!.size) {
								this.queue_dirs!.start();
								debug('UNpausing dir queue');
							}

						}, {priority : 1}); // Maximum priority for file uploads
				}
			}
		}
		
		// if files queue 3 times bigger than in settings - pausing dirs queue so it wont eat too much memory
		debug('queue_files.size', this.queue_files.size);
		if (3 * this.files_concurrency < this.queue_files.size) {
			this.queue_dirs.pause();
			debug('Pausing dir queue');
		}

		//console.log('AFTER FOR queue_files.size', this.queue_files.size);
		// Wait for both promises to resolve
		return Promise.all([this.queue_dirs.onIdle(), this.queue_files.onIdle()])
			.then(() => {
				// Both queues have finished their tasks
				debug("Both dir and files queus are finished.");
				return true;
			})
			.catch((error) => {
				// Handle errors if any of the promises reject
				debug("Error while waiting for queues to finish:", error);
				return JSON.stringify(error);
			});
	}

	/**
	 * Uploads a directory to S3, including subdirectories and files, skips empty dirs, slower version, waits till all files in dir will be uploaded and then goes to next dir
	 * Skips empty directories and follows a slower version that waits until
	 * all files in a directory are uploaded before proceeding to the next directory.
	 * @param {string} dir - Local directory path to upload.
	 * @param {string} [prefix=''] - Prefix to add to S3 object keys.
	 * @param {string} [acl='public-read'] - ACL (Access Control List) for the uploaded objects.
	 * @param {boolean} [overwrite=false] - Flag to overwrite existing files in S3.
	 * @returns {Promise<boolean>} - A promise resolving to true if the upload is successful.
	 */
	async uploadDir2(dir: string, prefix: string = '', acl: ObjectCannedACL = 'public-read', overwrite: boolean = false): Promise<boolean> {
		debug('uploadDir', dir, prefix);
		if (null === this.queue) {
			this.queue = new PQueue({concurrency: 1});
		}

		// adding trailing slash to add deeper path in the future
		if (!dir.endsWith('/')) dir += '/';
		// removing first slash, if exists
		prefix = prefix.replace(/^\//, '');

		let files_remote = await this.list(prefix);
		let files = fs.readdirSync(dir, { withFileTypes: true });

		let queue_files = new PQueue({concurrency: 50});
		let queue_files_filled = false;

		//console.log(files_remote);
		//console.log('filling files/dir queue');
		for (let file of files) {

			if (file.isDirectory()) {
				//console.log('uploadDir', dir, file.name, prefix, file.name);

				this.queue.add(() => {
					return this.uploadDir2(dir + file.name, prefix + file.name + '/', acl, overwrite);
				}, {priority : 0});

			} else {
				if (overwrite || !files_remote.includes(file.name)) {

					//console.log('queue_files');
					queue_files.add(() => {
						//console.log('upload', dir + file.name, prefix + file.name);
						return this.upload(dir + file.name, prefix + file.name, acl);
					}, {priority : 1}); // maximum priority for file uploads
				}
			}
		}
		
		queue_files_filled = true;

		//console.log('AFTER FOR queue_files.size', queue_files.size);
		//var self = this;

		return new Promise((resolve, reject) => {

			// waiting for files queue to be filled (if any files exists)
			let interval = setInterval(async () => {
				//console.log('interval')

				if (queue_files_filled) {
					//console.log('queue_files_filled = true, queue_files.size=', queue_files.size);
					clearInterval(interval);

					// waiting for files queue to be finished (::TRICKY:: if its 0 in queue it will trigger immediately)
					await queue_files.onIdle();

					//console.log('uploadDir finished', dir, 'dir queue size=', self.queue.size, self.queue.pending);

					resolve(true);
				}

			}, 1000);

		});
	}

	/**
	 * Uploads a file to S3, automatically creates directory if not exists
	 * @param {string} from - Local file path to upload.
	 * @param {string} to - S3 object key.
	 * @param {string} [acl='public-read'] - ACL (Access Control List) for the uploaded object.
	 * @returns {Promise} - A promise resolving when the upload is complete.
	 */
	async upload(from: string, to: string, acl: ObjectCannedACL = 'public-read', attempt: number = 0, cb: null | Function = null) {
		if (attempt) debug('attempt', attempt);
	    let self = this;

		// getting mime
		// mimetypes good only with files with extension
		let mime = mimetypes.lookup(from);

		if (!mime) {
			if ('function' !== typeof fileTypeFromFile) throw 'fileTypeFromFile is not loaded';
			// this one works for images and videos but not on .js/.json etc
			let res = await fileTypeFromFile(from);

			if (res) {
				mime = res.mime;
			} else {
				// getting mime from file extension (for .svg etc)
				mime = mimetypes.contentType(to.slice(-5))
			}
		}
		//console.log('file\'s mime', mime);

	    const readStream = fs.createReadStream(from);
	    const params: PutObjectCommandInput = {
	        Bucket: this.bucket,
	        Key: to,
	        Body: readStream,
	        ACL : acl, // remove if should be private
	    };
	    if (mime) {
	    	params.ContentType = mime;
	    }

		return new Promise((resolve, reject) => {
			this.s3!.send(new PutObjectCommand(params))
				.then(data => {
					readStream.destroy();
					if (typeof cb === 'function') cb(data);
					resolve(data);
				})
				.catch(err => {
					readStream.destroy();
					debug('Error uploading file:', err);
					if (err.name === 'SlowDown' || err.statusCode === 503) {
						debug('Received SlowDown error. Retrying in 1 sec...');
						if (attempt < 3) {
							setTimeout(() => {
								resolve(this.upload(from, to, acl, ++attempt, resolve));
							}, 1000);
						} else {
							debug('After trying 3 times upload failed');
							reject(err);
						}
					} else {
						reject(err);
					}
				});
		});
	}

	/**
	 * Downloads a file from S3. If success: returns downloaded file path, if fails: FALSE
	 * @param {string} from - S3 object key to download.
	 * @param {string} to - Local file path to save the downloaded file.
	 * @returns {Promise<string|boolean>} - A promise resolving to the local file path if successful, or false on failure.
	 */
	download(from: string, to: String) {
		if (!this.bucket) {
			throw new Error('Bucket is not defined.');
		}

	    const params = {
	        Bucket: this.bucket,
	        Key: from,
	    };
		debug('download method called with', params);
	    return new Promise(async (resolve, reject) => {
			try {
				const data = await this.s3!.send(new GetObjectCommand(params)).then(data => data.Body as Readable);
				//fs.writeFileSync(to, data.Body);

				const writableStream = fs.createWriteStream(to)
				data.pipe(writableStream);
		
				// Wait for the writable stream to finish writing the data to the file
				debug('waiting for stream to finish', to)

				try {
					await new Promise((resolve, reject) => {
						writableStream.on('finish', resolve);
						writableStream.on('error', error => reject(error.message));
					});
					resolve(to);
				} catch (e) {
					reject(e);
				}

			} catch (e) {
				debug(e);
				reject(e);
			}
	    });
	}

	/**
	 * Deletes a file from S3.
	 * @param {string} file - S3 object key to delete.
	 * @returns {Promise<string|boolean>} - A promise resolving to the deleted object key if successful, or false on failure.
	 */
	async delete(path: string, attempt: number = 0): Promise<string> {

	    let self = this;

	    const params = {
	        Bucket: this.bucket,
	        Key: path,
	    };
		try {
			await this.s3!.send(new DeleteObjectCommand(params));
			return path;
		} catch (err) {
			debug('Error:', err);
			if ('SlowDown' == err.name || (err.$metadata && err.$metadata.httpStatusCode === 503)) {
				debug('Received SlowDown error. Retrying in 2 sec...');
				if (attempt < 13) {
					await new Promise(resolve => setTimeout(resolve, 2000));
					return await this.delete(path, ++attempt); // <-----
				} else {
					debug('After trying 13 times "delete" failed', err);
					throw err;
				}
			} else {
				throw err;
			}
		}
	}

	/**
	 * Deletes all objects in a specified directory from S3.
	 * @param {string} path - S3 directory path to delete.
	 * @returns {Promise<Array>} - A promise resolving to an array of results for each deleted object.
	 */
	async deleteDir(path: string): Promise<true|string> {
		let files = await this.list(path);

		// adding slash in the end if dont have
		if ('/' != path.slice(-1)) {
			path += '/';
		}

		let promises = [];
		for (let file of files) {
			debug('Removing', path + file);
			promises.push(this.delete(path + file));
		}

		return Promise.allSettled(promises).then(results => {
			return true
		}).catch((err) => {
			return err;
		});
	}

	/**
	 * Lists objects in a specified S3 directory, by default only file names array without metadata
	 * @param {string} path - S3 directory path to list.
	 * @param {boolean} [full_data=false] - Flag to include full metadata for each object.
	 * @returns {Promise<Array|string>} - A promise resolving to an array of object keys or full metadata objects.
	 */
	list(path: string, full_data: boolean = false): Promise<(string | DirectoryItem)[]> {

		// adding slash in the end if missing
		path = path.replace(/\/?$/, '/');
		// if root path - removing / so it will work
		if ('/' == path) path = '';

		let params: ListParams = {
			Bucket: this.bucket,
			Delimiter: '/',
			Prefix: path,
			//MaxKeys: 2,
		};

		return this.listAllKeys(params, [], full_data);
	} 

	/**
	 * Retrieves metadata for a specified S3 object.
	 * @param {string} key - S3 object key for which to retrieve metadata.
	 * @returns {Promise<Object>} - A promise resolving to the metadata object for the specified S3 object.
	 */
	async getMetaData(key: string): Promise<any> {

		const params = {
			Bucket: this.bucket,
			Key: key,
		}
		const metaData = await this.s3!.send(new HeadObjectCommand(params));
		debug('Metadata:', metaData);

		return metaData;
	}

	// PRIVATE
	async listAllKeys(params: ListParams, out: (string | DirectoryItem)[] = [], full_data: boolean = false): Promise<(string | DirectoryItem)[]> {
		try {
			const response = await this.s3!.send(new ListObjectsV2Command(params));
			const { Contents, CommonPrefixes, IsTruncated, NextContinuationToken } = response;
	
			// Process directories
			if (Array.isArray(CommonPrefixes))
			for (const el of CommonPrefixes) if (el.Prefix !== undefined) {
				let name = el.Prefix.replace(new RegExp('^(' + params.Prefix + ')', 'g'), '');
				name = name.replace(/\/$/, '');
	
				if (full_data) {
					out.push({
						is_dir: true,
						name: name,
					});
				} else {
					out.push(name);
				}
			}
	
			// Process files
			if (Array.isArray(Contents))
			for (const el of Contents) if (el.Key !== undefined) {
				let name = el.Key.replace(new RegExp('^(' + params.Prefix + ')', 'g'), '');
	
				if (name) {
					if (full_data) {
						out.push({
							is_dir: false,
							name: name,
							mtime: el.LastModified,
							size: el.Size,
						});
					} else {
						out.push(name);
					}
				}
			}
	
			// Recursive call if there are more objects
			if (IsTruncated) {
				return await this.listAllKeys(Object.assign(params, { ContinuationToken: NextContinuationToken }), out, full_data);
			} else {
				return out;
			}
		} catch (err) {
			if (err.name === 'SlowDown' || err.$metadata?.httpStatusCode === 503) {
				console.debug('Received SlowDown error. Retrying in 1 sec...');
				await new Promise(resolve => setTimeout(resolve, 1000));
				return await this.listAllKeys(params, out, full_data);
			} else {
				throw err;
			}
		}
	}	
}
