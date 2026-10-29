FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM deps AS migrate
COPY tsconfig.json tsconfig.build.json drizzle.config.ts ./
COPY src ./src
COPY migrations ./migrations
CMD ["npm", "run", "migrate"]

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN npm prune --omit=dev
USER node
EXPOSE 4580
CMD ["node", "dist/server.js"]
