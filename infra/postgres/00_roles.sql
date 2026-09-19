DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='axiom_runtime') THEN CREATE ROLE axiom_runtime NOLOGIN NOBYPASSRLS; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='axiom_migrator') THEN CREATE ROLE axiom_migrator NOLOGIN; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='axiom_readonly') THEN CREATE ROLE axiom_readonly NOLOGIN NOBYPASSRLS; END IF;
END $$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
