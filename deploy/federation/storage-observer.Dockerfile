FROM oven/bun:1.4.2-alpine AS build
WORKDIR /build
COPY package.json bun.lock ./
COPY packages ./packages
COPY contracts ./contracts
COPY scripts/federation-storage-observer.ts ./scripts/federation-storage-observer.ts
RUN bun install --frozen-lockfile --ignore-scripts
RUN bun build scripts/federation-storage-observer.ts --target=bun --outfile=/observer.js

FROM oven/bun:1.4.2-alpine
COPY --from=build /observer.js /app/observer.js
USER bun
CMD ["bun", "/app/observer.js", "/run/kq-storage/observer.json"]
