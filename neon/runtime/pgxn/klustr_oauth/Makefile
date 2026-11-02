# Native PostgreSQL 18 OAuth validator; loaded by oauth_validator_libraries, no SQL extension.
MODULE_big = klustr_oauth
OBJS = klustr_oauth.o
PG_CPPFLAGS = $(shell pkg-config --cflags libcurl)
SHLIB_LINK = $(shell pkg-config --libs libcurl)
PG_CONFIG = pg_config
PGXS := $(shell $(PG_CONFIG) --pgxs)
include $(PGXS)
