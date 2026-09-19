FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile=false && pnpm --filter @axiom/web build
FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/apps/web/.next ./.next
COPY --from=build /app/apps/web/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
EXPOSE 3000
CMD ["node_modules/.bin/next","start"]
