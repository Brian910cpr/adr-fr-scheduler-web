-- 002_import_members.sql
BEGIN TRANSACTION;
INSERT OR REPLACE INTO members (member_number, full_name, cert_level, type3_driver, phone, email, is_admin) VALUES (1001, 'Gordon', 'AEMT', 1, '910-555-0101', 'Gordon@adr-fr.org', 0);
INSERT OR REPLACE INTO members (member_number, full_name, cert_level, type3_driver, phone, email, is_admin) VALUES (1002, 'Lynnsey', 'EMT-B', 0, '910-555-0102', 'Lynnsey@adr-fr.org', 0);
INSERT OR REPLACE INTO members (member_number, full_name, cert_level, type3_driver, phone, email, is_admin) VALUES (1003, 'AJ', 'EMT-B', 1, '910-555-0103', 'AJ@adr-fr.org', 0);
INSERT OR REPLACE INTO members (member_number, full_name, cert_level, type3_driver, phone, email, is_admin) VALUES (1004, 'Nikki', 'AEMT', 0, '910-555-0104', 'Nikki@adr-fr.org', 0);
INSERT OR REPLACE INTO members (member_number, full_name, cert_level, type3_driver, phone, email, is_admin) VALUES (1005, 'Shane', 'EMT-B', 0, '910-555-0105', 'Shane@adr-fr.org', 0);
INSERT OR REPLACE INTO members (member_number, full_name, cert_level, type3_driver, phone, email, is_admin) VALUES (1006, 'Brian', 'EMT-B', 0, '910-555-0106', 'Brian@adr-fr.org', 1);
INSERT OR REPLACE INTO members (member_number, full_name, cert_level, type3_driver, phone, email, is_admin) VALUES (1007, 'Cliff', 'NMV', 0, '910-555-0107', 'Cliff@adr-fr.org', 0);
INSERT OR REPLACE INTO members (member_number, full_name, cert_level, type3_driver, phone, email, is_admin) VALUES (1008, 'Steve', 'AEMT', 1, '910-555-0108', 'Steve@adr-fr.org', 1);
INSERT OR REPLACE INTO members (member_number, full_name, cert_level, type3_driver, phone, email, is_admin) VALUES (1009, 'Roger', 'EMT-B', 1, '910-555-0109', 'Roger@adr-fr.org', 0);
INSERT OR REPLACE INTO members (member_number, full_name, cert_level, type3_driver, phone, email, is_admin) VALUES (1010, 'Anna', 'AEMT', 1, '910-555-0110', 'Anna@adr-fr.org', 0);
INSERT OR REPLACE INTO members (member_number, full_name, cert_level, type3_driver, phone, email, is_admin) VALUES (1011, 'Nick', 'AEMT', 1, '910-555-0111', 'Nick@adr-fr.org', 1);
INSERT OR REPLACE INTO members (member_number, full_name, cert_level, type3_driver, phone, email, is_admin) VALUES (1012, 'Lisa', 'AEMT', 1, '910-555-0111', 'Lisa@adr-fr.org', 0);
COMMIT;