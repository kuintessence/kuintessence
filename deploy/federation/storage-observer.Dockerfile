FROM oven/bun:1.4.2-alpine AS build
WORKDIR /build
COPY package.json bun.lock ./
COPY packages ./packages
COPY contracts ./contracts
COPY scripts/federation-storage-observer.ts scripts/federation-storage-reserve.ts ./scripts/
RUN bun install --frozen-lockfile --ignore-scripts
RUN bun build scripts/federation-storage-observer.ts --target=bun --outfile=/observer.js
RUN bun build scripts/federation-storage-reserve.ts --target=bun --outfile=/reserve.js

FROM oven/bun:1.4.2-alpine
RUN apk add --no-cache util-linux
COPY --from=build /observer.js /app/observer.js
COPY --from=build /reserve.js /app/reserve.js
USER bun
CMD ["bun", "/app/observer.js", "/run/kq-storage/observer.json"]
