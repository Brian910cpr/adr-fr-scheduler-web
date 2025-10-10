-- server/seed/010_add_volunteer_duty.sql
-- Adds the reserved placeholder member for weekend Driver policy

INSERT INTO members (id, display_name, is_placeholder, exclude_from_reports, payroll_exempt, active)
VALUES ('VOLUNTEER_DUTY', 'Volunteer Duty', 1, 1, 1, 1)
ON CONFLICT (id) DO UPDATE SET active=1, is_placeholder=1, exclude_from_reports=1, payroll_exempt=1;