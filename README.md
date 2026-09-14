## GitHub Action to upload files to Yandex Cloud Object Storage

[![Coverage](./badges/coverage.svg)](./badges/coverage.svg)

The action uploads files from the given folder to Yandex Cloud Object Storage using Service Account Key as
authorizations method.

**Table of Contents**

<!-- toc -->

- [Usage](#usage)
    - [Authentication](#authentication)
    - [Selecting files to upload](#selecting-files-to-upload)
    - [Clearing the bucket before upload](#clearing-the-bucket-before-upload)
    - [Setting the Cache-Control header](#setting-the-cache-control-header)
    - [Concurrency](#concurrency)
    - [Failing on upload errors](#failing-on-upload-errors)
    - [Skipping unchanged files](#skipping-unchanged-files)
- [Permissions](#permissions)
- [License Summary](#license-summary)

<!-- tocstop -->

## Usage

```yaml
- name: Upload files to Object Storage
  id: s3-upload
  uses: yc-actions/yc-obj-storage-upload@v5
  with:
      yc-sa-json-credentials: ${{ secrets.YC_SA_JSON_CREDENTIALS }}
      bucket: ${{ secrets.BUCKET }}
      root: ./src
      include: |
          *.js
          package.json
      exclude: |
          **/*.ts
```

See [action.yml](action.yml) for the full documentation for this action's inputs and outputs.

### Authentication

One of `yc-sa-json-credentials`, `yc-iam-token` or `yc-sa-id` should be provided depending on the authentication method
you want to use. The action will use the first one it finds.

- `yc-sa-json-credentials` should contain JSON with authorized key for Service Account. More info in
  [Yandex Cloud IAM documentation](https://yandex.cloud/en/docs/iam/operations/authentication/manage-authorized-keys#cli_1).
- `yc-iam-token` should contain IAM token. It can be obtained using `yc iam create-token` command or using
  [yc-actions/yc-iam-token-fed](https://github.com/yc-actions/yc-iam-token-fed)

    ```yaml
    - name: Get Yandex Cloud IAM token
      id: get-iam-token
      uses: docker://ghcr.io/yc-actions/yc-iam-token-fed:1.0.0
      with:
          yc-sa-id: aje***
    ```

- `yc-sa-id` should contain Service Account ID. It can be obtained using `yc iam service-accounts list` command. It is
  used to exchange GitHub token for IAM token using Workload Identity Federation. More info in
  [Yandex Cloud IAM documentation](https://yandex.cloud/ru/docs/iam/concepts/workload-identity).

### Selecting files to upload

The `root` input sets the folder whose contents are uploaded; keys in the bucket are relative to it. Use `include` and
`exclude` to filter files with glob patterns (one pattern per line).

<!-- prettier-ignore -->
> [!IMPORTANT]
> Glob patterns in `include` are **not recursive by default**. The default value `*` matches only files located
> directly in `root`; files in nested directories are not uploaded. To upload a folder with all of its subdirectories,
> use the `**/*` pattern:

```yaml
- name: Upload files to Object Storage
  id: s3-upload
  uses: yc-actions/yc-obj-storage-upload@v5
  with:
      yc-sa-json-credentials: ${{ secrets.YC_SA_JSON_CREDENTIALS }}
      bucket: ${{ secrets.BUCKET }}
      root: ./dist
      include: '**/*'
```

`exclude` patterns are matched against the same path as `include`: the file's location relative to `root`, which is also
the key it would get in the bucket. A pattern containing a slash is therefore anchored at `root` —
`exclude: assets/*.map` drops `assets/app.js.map` but nothing deeper. A pattern without a slash matches the file name at
any depth, so `exclude: '*.map'` drops every source map, wherever it sits.

<!-- prettier-ignore -->
> [!NOTE]
> This changed in v5. Before v5, `exclude` patterns were matched against the path relative to the repository root rather
> than to `root`, so any pattern containing a slash silently matched nothing. Patterns without a slash, and patterns
> starting with `**/`, behave as they always did.

### Clearing the bucket before upload

Use the `clear: true` option to delete all objects from the bucket before uploading files.

```yaml
- name: Upload files to Object Storage
  id: s3-upload
  uses: yc-actions/yc-obj-storage-upload@v5
  with:
      yc-sa-id: ${{ secrets.YC_SA_ID }}
      bucket: ${{ secrets.BUCKET }}
      root: ./src
      include: |
          *.js
          package.json
      exclude: |
          **/*.ts
      clear: true
```

### Setting the Cache-Control header

If you want to configure `Cache-Control` header for uploaded files, you can use `cache-control` option.

Value of `*` key will be used as default value for all files. You can also specify cache control for file paths.

```yaml
- name: Upload files to Object Storage
  id: s3-upload
  uses: yc-actions/yc-obj-storage-upload@v5
  with:
      yc-sa-json-credentials: ${{ secrets.YC_SA_JSON_CREDENTIALS }}
      bucket: ${{ secrets.BUCKET }}
      root: ./src
      include: |
          *.js
          package.json
      exclude: |
          **/*.ts
      cache-control: |
          *.js, *.css: public, max-age=31536000, immutable
          *.png, *.jpg, *.jpeg, *.gif, *.svg, *.ico: public, max-age=31536000
          *.html: max-age=3600
          *: no-cache
```

### Concurrency

Files are uploaded in parallel. Use the `concurrency` option to control how many files are uploaded at once (default
`16`; values below `1` are clamped to `1`, values above `256` are clamped to `256`).

### Failing on upload errors

By default, upload errors are logged but do not fail the action (the previous behavior). Set `fail-on-error: true` to
make the action fail when one or more files could not be uploaded; every file is still attempted first.

### Skipping unchanged files

To avoid re-uploading files that have not changed, set `skip-unchanged: true`. For each file the action issues a
`HeadObject` request and skips the upload when the remote object's ETag equals the local file's MD5. Note that this is a
content-only comparison: changing `cache-control` alone (with identical file content) will not trigger a re-upload, and
objects stored as multipart uploads are always re-uploaded.

```yaml
- name: Upload files to Object Storage
  id: s3-upload
  uses: yc-actions/yc-obj-storage-upload@v5
  with:
      yc-sa-json-credentials: ${{ secrets.YC_SA_JSON_CREDENTIALS }}
      bucket: ${{ secrets.BUCKET }}
      root: ./src
      include: |
          *.js
          package.json
      concurrency: 32
      skip-unchanged: true
```

## Permissions

To perform this action, it is required that the service account on behalf of which we are acting has granted the
`storage.uploader` role or greater.

If you want to clear bucket before uploading files using `clear: true` option, the service account should have
`storage.editor` role or greater.

## License Summary

This code is made available under the MIT license.
