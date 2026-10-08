// Semgrep test fixture (generic language: the annotations are // comments, not SQL).
CREATE OR REPLACE FUNCTION fn_audit() RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO users_audit_log (previous_data, new_data) VALUES (
        // ruleid: gdpr-sql-whole-row-json
        to_jsonb(OLD),
        // ruleid: gdpr-sql-whole-row-json
        row_to_json(NEW)
    );
    INSERT INTO users_audit_log (previous_data, new_data) VALUES (
        // ok: gdpr-sql-whole-row-json
        to_jsonb(OLD) - v_excluded,
        // ok: gdpr-sql-whole-row-json
        to_jsonb(NEW) - ARRAY['password', 'photo']
    );
    // ok: gdpr-sql-whole-row-json
    SELECT jsonb_agg(to_jsonb(l)) FROM connection_logs l;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
