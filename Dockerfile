# One image definition for all seven services. Which service an image runs is
# chosen at build time:
#
#   docker build --build-arg APP=gateway -t train-app/gateway .
#
# APP must be one of the application names in nest-cli.json: catalog, gateway,
# identity, inventory, booking, payment, notification.

# ---- deps: the full install, cached on the lockfile alone ----------------
FROM node:24-alpine AS deps
WORKDIR /usr/src/app
COPY package.json package-lock.json ./
RUN npm ci

# ---- build: compile one app out of the monorepo --------------------------
FROM node:24-alpine AS build
WORKDIR /usr/src/app
ARG APP
RUN test -n "$APP" || (echo "APP build arg is required (e.g. --build-arg APP=gateway)" >&2; exit 1)
COPY --from=deps /usr/src/app/node_modules ./node_modules
COPY . .
# The workspace is ESM, so nest-cli builds with tsc; each app's rootDir is the
# repo root (so that libs/ is in scope), which puts the entry at
# dist/apps/<APP>/src/main.js. The `test -f` is a guard: without it a layout
# change produces an image that builds and then exits instantly at runtime.
RUN npx nest build "$APP" && mkdir -p dist/libs/contracts/src/proto && cp libs/contracts/src/proto/*.proto dist/libs/contracts/src/proto/ && test -f "dist/apps/$APP/src/main.js"

# ---- seeder: a one-off that seeds every service's database --------------
# Not one of the seven services, and never started by `compose up`: the compose
# service carries `profiles: ["seed"]`, so it runs only when asked for.
#
# It needs two apps' output. Both are built with `nest build`, never plain
# `tsc`: only nest-cli rewrites the `@app/*` path aliases into the relative
# paths Node can resolve, and `tsc` leaves them as bare specifiers that fail at
# runtime. nest-cli also sets `deleteOutDir`, so the second app cannot be built
# over the first -- hence one stage each, merged below.
FROM deps AS build-identity
WORKDIR /usr/src/app
COPY . .
RUN npx nest build identity

FROM build AS seeder
WORKDIR /usr/src/app
# Merges identity's output into catalog's: both emit the shared libs each one
# imports, and the union is what the seeds need.
COPY --from=build-identity /usr/src/app/dist ./dist
RUN test -f dist/apps/catalog/src/database/seeds/catalog.seed.js \
 && test -f dist/apps/identity/src/database/seeds/staff-accounts.seed.js \
 && test -f dist/libs/contracts/src/index.js \
 && ! grep -rq "from '@app/" dist/apps dist/libs
USER node
CMD ["node", "scripts/seed-all.mjs"]

# ---- runtime: production dependencies plus the compiled app -------------
FROM node:24-alpine AS runtime
WORKDIR /usr/src/app
ENV NODE_ENV=production
# package.json carries "type": "module"; without it Node reads dist/ as CommonJS.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /usr/src/app/dist ./dist
COPY libs/contracts/src/proto ./libs/contracts/src/proto

# ARG does not interpolate in exec-form CMD. Promote it to an ENV and use shell
# form so the app name survives into the running container.
ARG APP
ENV APP=${APP}
ENV PORT=3000

USER node
EXPOSE 3000
CMD ["sh", "-c", "node dist/apps/$APP/src/main"]
