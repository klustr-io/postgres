# Run from the PostgreSQL repository root.
.DEFAULT_GOAL := help
.PHONY: help build plan unit native
help:
	@echo 'build: all seven images; plan: inspect inputs; unit: controller checks; native: engine-only development'
build:
	node neon/build.mjs
plan:
	node neon/build.mjs --plan
unit:
	node --test neon/tests/neon/unit/*.test.mjs
native:
	bash neon/dev/build/postgres/native.sh build
