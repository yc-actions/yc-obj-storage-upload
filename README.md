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
      uses: yc-actions/yc-obj-storage-upload@v2
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

`yc-sa-json-credentials` should contain JSON with authorized key for Service Account. More info
in [Yandex Cloud IAM documentation](https://cloud.yandex.ru/docs/container-registry/operations/authentication#sa-json).

You can also use `clear: true` option to clear bucket before uploading files.

```yaml
    - name: Upload files to Object Storage
      id: s3-upload
      uses: yc-actions/yc-obj-storage-upload@v2
      with:
        yc-sa-json-credentials: ${{ secrets.YC_SA_JSON_CREDENTIALS }}
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
      uses: yc-actions/yc-obj-storage-upload@v2
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
