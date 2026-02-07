ARG BUILD_FROM
FROM $BUILD_FROM

# Install Node.js
RUN apk add --no-cache nodejs npm

# Copy app
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./

# Run directly without s6-overlay
CMD ["node", "server.js"]
