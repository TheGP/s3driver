import s3driver from '../dist/index.js';
import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename) + '/..';

let s3;
const directoryPath = __dirname + '/temp/testDirectory';

describe('s3driver', () => {
    beforeAll(() => {
        // Create directory synchronously
        try {
            fs.mkdirSync(directoryPath, { recursive: true });
            console.log('Directory created successfully.');
        
            // File content
            const file1Content = 'test1.txt';
            const file2Content = 'test2.txt';
        
            // Write content to files
            fs.writeFileSync(path.join(directoryPath, 'test1.txt'), file1Content);
            console.log('test1.txt created successfully.');
        
            fs.writeFileSync(path.join(directoryPath, 'test2.txt'), file2Content);
            console.log('test2.txt created successfully.');

			s3 = new s3driver();
			// Mock S3 configuration
			const config = {
				accessKeyId: process.env.ACCESS_KEY_ID,
				secretAccessKey: process.env.SECRET_ACCESS_KEY,
				endpoint: process.env.ENDPOINT,
				bucket: process.env.BUCKET,
			};

			s3.config(config);
        } catch (err) {
            console.error('Error occurred:', err);
        }
    });

    test.only('should upload a directory', async () => {
        const uploadResult = await s3.uploadDir(directoryPath, 's3testdir/');
        expect(uploadResult).toBe(true);
    }, 10000);

    test.only('should list files with uploaded directory', async () => {
        const res = await s3.list('');
		//console.log('res', res);
        expect(res).toContain('s3testdir');
    }, 10000);

    test.only('should list files of uploaded directory too', async () => {
        const res = await s3.list('s3testdir');
		//console.log('res', res);
        expect(res).toEqual(['test1.txt', 'test2.txt']);
    }, 10000);

    test.only('should list files of uploaded directory with full_data = true', async () => {
        const res = await s3.list('s3testdir', true); // Pass true to indicate full_data = true
        const expectedResult = [
            {
                is_dir: false,
                name: 'test1.txt',
                mtime: expect.any(Date),
                size: 9
            },
            {
                is_dir: false,
                name: 'test2.txt',
                mtime: expect.any(Date),
                size: 9
            }
        ];
        // Check if the response matches the expected result
        expect(res).toEqual(expect.arrayContaining(expectedResult));
    });

    test.only('should get metadata of test1.txt', async () => {
        // Get metadata of test1.txt from S3
        const metaData = await s3.getMetaData('s3testdir/test1.txt');
        
        // Assert that metadata is returned
        expect(metaData).toBeDefined();
        
        // Assert specific metadata properties if needed
        expect(metaData.ContentLength).toBeGreaterThan(0);

        // Check if metadata has '$metadata' field
        expect('$metadata' in metaData).toBe(true);
    }, 10000);

	test.only('should download the uploaded directory', async () => {
		// Define the local path where the directory will be downloaded
		const localDownloadPath = __dirname + '/temp/downloadedDir';
	
		// Download the directory from S3
		const downloadResult = await s3.downloadDir('s3testdir', localDownloadPath);
		expect(downloadResult).toBe(true);

	    //process.exit();
		// Check if the downloaded directory exists
		const directoryExists = fs.existsSync(localDownloadPath);
		expect(directoryExists).toBe(true);
	
		// Check if the downloaded directory contains the expected files
		const downloadedFiles = fs.readdirSync(localDownloadPath);
		expect(downloadedFiles).toEqual(['test1.txt', 'test2.txt']);

        // Check the content of each downloaded file
        const file1Content = fs.readFileSync(path.join(localDownloadPath, 'test1.txt'), 'utf-8');
        expect(file1Content).toEqual('test1.txt');
        const file2Content = fs.readFileSync(path.join(localDownloadPath, 'test2.txt'), 'utf-8');
        expect(file2Content).toEqual('test2.txt');

	}, 30000);

    test.only('should upload a directory from cloud to cloud', async () => {
        // Mock S3 configuration for the destination bucket
        const destConfig = {
            accessKeyId: process.env.ACCESS_KEY_ID,
            secretAccessKey: process.env.SECRET_ACCESS_KEY,
            endpoint: process.env.ENDPOINT,
            bucket: process.env.BUCKET,
        };
    
        // Set up the source directory path
        const sourceDir = 's3testdir/';
    
        // Call the uploadDirCloud method to upload the directory
        const uploadResult = await s3.uploadDirCloud(destConfig, sourceDir, 's3testdir-copy');
    
        // Check if the upload was successful
        expect(uploadResult).toBe(true);
    
        // Check if the uploaded directory exists in the destination bucket
        const res = await s3.list('', true); // List all files with full data
        const uploadedDirectory = res.find(item => item.name === 's3testdir-copy' && item.is_dir);
        expect(uploadedDirectory).toBeDefined();

        // Checking if all files has been uploaded correctly
        const res2 = await s3.list('s3testdir-copy');
        expect(res2).toEqual(['test1.txt', 'test2.txt']);
    }, 10000);

    test.only('should delete a file from the uploaded directory', async () => {
        // Delete the file from S3
        const deleteResult = await s3.delete('s3testdir/test1.txt');
        expect(deleteResult).toBe('s3testdir/test1.txt');
    
        // Check if the file is no longer listed
        const res = await s3.list('s3testdir');
        expect(res).not.toContain('test1.txt');
    }, 15000);

    test.only('should delete the uploaded directory', async () => {
        // Delete the directory from S3
        const deleteResult = await s3.deleteDir('s3testdir');
        expect(deleteResult).toBe(true);
    
        // Check if the directory is no longer listed
        const res = await s3.list('');
        expect(res).not.toContain('s3testdir');
    }, 20000);

    afterAll(async () => {
        // Clean up: Remove test directory and files
        fs.rmSync(__dirname + '/temp', { recursive: true });
        console.log('Test directory deleted successfully.');

        await s3.deleteDir('s3testdir-copy');
    });
});