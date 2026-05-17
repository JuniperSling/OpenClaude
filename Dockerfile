FROM node:25-slim AS base
WORKDIR /app

COPY package.json ./
COPY apps ./apps
COPY packages ./packages
COPY tsconfig.base.json ./

RUN npm install
RUN npm run build

FROM node:25-slim AS api
WORKDIR /app
ENV NODE_ENV=production
COPY --from=base /app ./
EXPOSE 4000
CMD ["npm", "--workspace", "@openclaude/api", "run", "start"]

FROM node:25-slim AS web
WORKDIR /app
ENV NODE_ENV=production
COPY --from=base /app ./
EXPOSE 3000
CMD ["npm", "--workspace", "@openclaude/web", "run", "start"]
