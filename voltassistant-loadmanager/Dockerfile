ARG BUILD_FROM
FROM $BUILD_FROM

# Install Node.js
RUN apk add --no-cache nodejs npm

# Copy app
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./

# Copy s6-overlay service
COPY rootfs /
