# pgxs/neon/Makefile


MODULE_big = neon_rmgr
OBJS = \
	$(WIN32RES) \
	neon_rmgr.o \
	neon_rmgr_decode.o \
	neon_rmgr_desc.o


EXTENSION = neon_rmgr
DATA = 
PGFILEDESC = "Neon WAL Resource Manager - custom WAL records used to make Neon work (since PG 16)"


PG_CONFIG = pg_config
# PG18 uses its own API-compatible handler. Keep PG14-17 behavior unchanged.
NEON_PG_MAJOR := $(shell $(PG_CONFIG) --version | sed -E 's/.* ([0-9]+).*/\1/')
ifeq ($(NEON_PG_MAJOR),18)
OBJS = $(WIN32RES) neon_pg18_rmgr.o neon_pg18_decode.o neon_pg18_desc.o
endif
PGXS := $(shell $(PG_CONFIG) --pgxs)
include $(PGXS)
