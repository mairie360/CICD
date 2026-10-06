-- Columns of the migrated schema, as the JSON check.mjs reads (MAIR-285): every column of every
-- table of `public`, partitions excluded (they share their parent's columns), with the table its
-- foreign key references, if any.
SELECT coalesce(json_agg(row_to_json(t) ORDER BY t.table_name, t.position), '[]')
FROM (
    SELECT c.relname AS table_name,
           a.attname AS column_name,
           a.attnum AS position,
           format_type(a.atttypid, a.atttypmod) AS type,
           NOT a.attnotnull AS nullable,
           col_description(c.oid, a.attnum) AS comment,
           (SELECT f.confrelid::regclass::text
              FROM pg_constraint f
             WHERE f.conrelid = c.oid AND f.contype = 'f' AND a.attnum = ANY (f.conkey)
             ORDER BY f.conname
             LIMIT 1) AS refers_to
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
) t;
