# Node 22 LTS, slim Debian: much smaller than the full image
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

# Only what the server needs to run (no jest, nodemon...)
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# Run as the image's unprivileged user, not root
USER node

EXPOSE 3001

CMD ["node", "server.js"]
