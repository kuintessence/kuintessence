FROM oven/bun:1.4.2-alpine AS build
WORKDIR /build
COPY packages/server/src/federation/gateway.ts packages/server/src/federation/gateway-main.ts ./
RUN bun build ./gateway-main.ts --target=node --outfile=/gateway.mjs

FROM node:22.23.3-bookworm-slim
COPY --from=build /gateway.mjs /app/gateway.mjs
ENV NODE_ENV=production
CMD ["node", "/app/gateway.mjs"]
