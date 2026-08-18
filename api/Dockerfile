FROM node:20-alpine

WORKDIR /app

# Copy manifests first so the install layer caches across source edits.
COPY package.json ./
RUN npm install

COPY src ./src

ENV NODE_ENV=development
EXPOSE 3000

CMD ["npm", "run", "dev"]
