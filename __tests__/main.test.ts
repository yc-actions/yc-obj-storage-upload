import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import {expect, test} from '@jest/globals';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as process from 'process';
import {upload, UploadInputs} from '../src/main';

// This test will run only in fully configured env and creates real VM
// in the Yandex Cloud, so it will be disabled in CI/CD. You can enable it to test locally.
test.skip('test runs', () => {
  process.env['INPUT_INCLUDE'] = '.\n./package.json';
  process.env['INPUT_EXCLUDE'] = '**/*.txt\n**/*.yaml\n**/*.ts';
  process.env['INPUT_TAGS'] = 'foo\nbar';

  const np = process.execPath;
  const ip = path.join(__dirname, '..', 'lib', 'main.js');
  const options: cp.ExecFileSyncOptions = {
    env: process.env,
    cwd: __dirname,
  };
  let res;
  try {
    res = cp.execFileSync(np, [ip], options);
  } catch (e) {
    console.log((e as any).stdout.toString());
    console.log((e as any).stderr.toString());
  }
  console.log(res?.toString());
});

describe('upload', function () {
  const s3client = new S3Client({});
  const mockedSendFn = jest.spyOn(s3client, 'send');

  beforeEach(() => {
    mockedSendFn.mockReset();
  });

  test('it should add files from include', async () => {
    const inputs: UploadInputs = {
      bucket: 'bucket',
      prefix: '',
      include: ['./src/*'],
      exclude: [],
      root: '.',
    };

    await upload(s3client, inputs);

    expect(mockedSendFn).toBeCalledTimes(3);
    const keys = mockedSendFn.mock.calls.map(([cmd]) => (cmd as PutObjectCommand).input.Key).sort();
    expect(keys).toEqual(['src/exclude.txt', 'src/exclude.yaml', 'src/func.js']);
  });

  test('it should drop files from if they do not match include patterns', async () => {
    const inputs: UploadInputs = {
      bucket: 'bucket',
      prefix: '',
      include: ['./src/*.js'],
      exclude: [],
      root: '.',
    };

    await upload(s3client, inputs);

    expect(mockedSendFn).toBeCalledTimes(1);
    const keys = mockedSendFn.mock.calls.map(([cmd]) => (cmd as PutObjectCommand).input.Key).sort();
    expect(keys).toEqual(['src/func.js']);
  });

  test('it should drop files from if they match exclude patterns', async () => {
    const inputs: UploadInputs = {
      bucket: 'bucket',
      prefix: '',
      include: ['./src/*'],
      exclude: ['*.txt'],
      root: '.',
    };

    await upload(s3client, inputs);

    expect(mockedSendFn).toBeCalledTimes(2);
    const keys = mockedSendFn.mock.calls.map(([cmd]) => (cmd as PutObjectCommand).input.Key).sort();
    expect(keys).toEqual(['src/exclude.yaml', 'src/func.js']);
  });

  test('it should drop folder prefix if sourceRoot provided', async () => {
    const inputs: UploadInputs = {
      bucket: 'bucket',
      prefix: '',
      include: ['*'],
      exclude: [],
      root: './src',
    };

    await upload(s3client, inputs);

    expect(mockedSendFn).toBeCalledTimes(3);
    const keys = mockedSendFn.mock.calls.map(([cmd]) => (cmd as PutObjectCommand).input.Key).sort();
    expect(keys).toEqual(['exclude.txt', 'exclude.yaml', 'func.js']);
  });

  test('it should respect source root and include only needed files', async () => {
    const inputs: UploadInputs = {
      bucket: 'bucket',
      prefix: '',
      include: ['*.js'],
      exclude: [],
      root: './src',
    };

    await upload(s3client, inputs);

    expect(mockedSendFn).toBeCalledTimes(1);
    const keys = mockedSendFn.mock.calls.map(([cmd]) => (cmd as PutObjectCommand).input.Key).sort();
    expect(keys).toEqual(['func.js']);
  });

  test('it should add prefix', async () => {
    const inputs: UploadInputs = {
      bucket: 'bucket',
      prefix: 'prefix/',
      include: ['*.js'],
      exclude: [],
      root: './src',
    };

    await upload(s3client, inputs);

    expect(mockedSendFn).toBeCalledTimes(1);
    const keys = mockedSendFn.mock.calls.map(([cmd]) => (cmd as PutObjectCommand).input.Key).sort();
    expect(keys).toEqual(['prefix/func.js']);
  });

  jest.setTimeout(600_000);
  test('it should use multipart on big files', async () => {
    const inputs: UploadInputs = {
      bucket: 'bucket',
      prefix: '',
      include: ['10mbfile.txt'],
      exclude: [],
      root: './bigfile',
    };
    const cwd = process.env.GITHUB_WORKSPACE ?? '';
    let createCommands = 0;
    let uploadCommands = 0;
    let completeCommands = 0;

    let createMultipartUploadCommand: CreateMultipartUploadCommand | undefined;

    mockedSendFn.mockImplementation(cmd => {
      if (cmd instanceof CreateMultipartUploadCommand) {
        createCommands += 1;
        createMultipartUploadCommand = cmd;
        return Promise.resolve({
          UploadId: 1,
        });
      }
      if (cmd instanceof UploadPartCommand) {
        uploadCommands += 1;
        return Promise.resolve({
          ETag: Math.random().toString().slice(2),
        });
      }
      if (cmd instanceof CompleteMultipartUploadCommand) {
        completeCommands += 1;
        return Promise.resolve({
          ETag: Math.random().toString().slice(2),
        });
      }
    });

    try {
      fs.mkdirSync(path.join(cwd, './bigfile'));
    } catch (e: any) {
      if (e.code !== 'EEXIST') {
        console.log(e);
        throw e;
      }
    }
    fs.writeFileSync(path.join(cwd, './bigfile/10mbfile.txt'), new Uint8Array(10 * 1024 ** 2));

    await upload(s3client, inputs);

    expect(mockedSendFn).toBeCalledTimes(5);
    expect(createCommands).toEqual(1);
    expect(uploadCommands).toEqual(3);
    expect(completeCommands).toEqual(1);
    if (!createMultipartUploadCommand) {
      throw new Error('createMultipartUploadCommand === null');
    }
    expect(createMultipartUploadCommand.input.Key).toEqual('10mbfile.txt');
  });
});
