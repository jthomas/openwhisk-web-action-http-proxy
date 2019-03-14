# NodeJS + Express Web Action Proxy Example

This example demonstrates how to run an existing Node.js web application (built using Express) on Apache OpenWhisk with the Web Action Proxy.

These steps can be used to wrap other Node.js web applications. 

## example application

This is the example application that will be wrapped into a Docker image with the Web Action Proxy.

https://github.com/shapeshed/express_example

![Express Example](https://camo.githubusercontent.com/2aa43809d8d8a9f9ccb906c1028d81f1ba1913d9/687474703a2f2f7368617065736865642e636f6d2f696d616765732f61727469636c65732f657870726573735f6578616d706c652e6a7067)

The web application renders static HTML content for three routes (`/`,  `/about` and `/contact`). CSS files and fonts are also served by the backend.

## instructions

### clone project repo and install modules

```
git clone https://github.com/shapeshed/express_example.git
```

- Run `npm install` in the `express_example` directory to download the project modules.

### modify the url references

Due to the limitations of the Web Action Proxy, all URLs (for local files) in HTML and CSS files must refer to relative locations, e.g.`./about` rather than `/about`.

- Replace URL paths with relative locations in  `views/layout.jade`

```diff
-            a(href="/") Home
+            a(href="./") Home
           li
-            a(href="/about") About
+            a(href="./about") About
           li
-            a(href="/contact") Contact
+            a(href="./contact") Contact
```

- Replace URL paths with relative locations in  `public/stylesheets/chunkfive-fontface.css` 

```diff
-    link(rel='stylesheet', href='/stylesheets/style.css')
-    link(rel='stylesheet', href='/stylesheets/chunkfive-fontface.css')
+    link(rel='stylesheet', href='./stylesheets/style.css')
+    link(rel='stylesheet', href='./stylesheets/chunkfive-fontface.css')
```

### create docker build file assets

- Create a Dockerfile in the parent directory to the `express_example` with the following contents.

```
FROM node:10

ADD express_example /app/
ADD script.sh /app/
ADD proxy /app/

ENV PROXY_PORT 3000
EXPOSE 8080

WORKDIR /app
CMD ./script.sh
```

- Copy the `proxy` binary from the Web Action Proxy repo to the parent directory of `express_example`.

- Create a `script.sh` file in the parent directory to the `express_example` with the following contents.

```bash
#!/bin/bash

./proxy & npm start
```

### docker build, tag and push!

- Build the Docker image for the example application.

```
 docker build -t expressjs .
```

- Tag the local image with the Docker Hub repo name.

```
 docker tag expressjs <USERNAME>/expressjs
```

- Push the local image to Docker Hub.

```
 docker push jamesthomas/expressjs
```

### create web action

- Create the Apache OpenWhisk Web Action from the public Docker image.

```
wsk action create expressjs --docker <USERNAME>/expressjs --web true
```

### access web application

- Retrieve the Web Action URL for the `expressjs` action.

```
 wsk action get expressjs --url
```

- Open the Web Action URL (with a `/` appended to the action name) in a web browser, i.e.

```
https://<OW_HOST>/api/v1/web/<NAMESPACE>/default/expressjs/
```

**Important: Page links won't work unless the Web Action URL ends with a `/` after the action name.**

![Express Example](https://camo.githubusercontent.com/2aa43809d8d8a9f9ccb906c1028d81f1ba1913d9/687474703a2f2f7368617065736865642e636f6d2f696d616765732f61727469636c65732f657870726573735f6578616d706c652e6a7067)