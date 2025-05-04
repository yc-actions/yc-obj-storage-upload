## GitHub Action to upload files to Yandex Cloud Object Storage.

[![Coverage](./badges/coverage.svg)](./badges/coverage.svg)

The action uploads files from the given folder to Yandex Cloud Object Storage using Service Account Key as
authorizations method.

**Table of Contents**

<!-- toc -->

- [Usage](#usage)
- [Permissions](#permissions)
- [License Summary](#license-summary)

<!-- tocstop -->

## Usage

```yaml
    - name: Upload files to Object Storage
      id: s3-upload
      uses: yc-actions/yc-obj-storage-upload@v3
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

One of `yc-sa-json-credentials`, `yc-iam-token` or `yc-sa-id` should be provided depending on the authentication method you
want to use. The action will use the first one it finds.
* `yc-sa-json-credentials` should contain JSON with authorized key for Service Account. More info
  in [Yandex Cloud IAM documentation](https://yandex.cloud/en/docs/iam/operations/authentication/manage-authorized-keys#cli_1).
* `yc-iam-token` should contain IAM token. It can be obtained using `yc iam create-token` command or using
  [yc-actions/yc-iam-token-fed](https://github.com/yc-actions/yc-iam-token-fed)
```yaml
  - name: Get Yandex Cloud IAM token
    id: get-iam-token
    uses: docker://ghcr.io/yc-actions/yc-iam-token-fed:1.0.0
    with:
      yc-sa-id: aje***
```
* `yc-sa-id` should contain Service Account ID. It can be obtained using `yc iam service-accounts list` command. It is
  used to exchange GitHub token for IAM token using Workload Identity Federation. More info in [Yandex Cloud IAM documentation](https://yandex.cloud/ru/docs/iam/concepts/workload-identity).

You can also use `clear: true` option to clear bucket before uploading files.

```yaml
    - name: Upload files to Object Storage
      id: s3-upload
      uses: yc-actions/yc-obj-storage-upload@v3
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

If you want to configure `Cache-Control` header for uploaded files, you can use `cache-control` option.

Value of `*` key will be used as default value for all files. You can also specify cache control for file paths.

```yaml
    - name: Upload files to Object Storage
      id: s3-upload
      uses: yc-actions/yc-obj-storage-upload@v3
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

See [action.yml](action.yml) for the full documentation for this action's inputs and outputs.

## Permissions

To perform this action, it is required that the service account on behalf of which we are acting has granted the
`storage.uploader` role or greater.
If you want to clear bucket before uploading files using `clear: true` option, the service account should have
`storage.editor` role or greater.

## License Summary

This code is made available under the MIT license.
