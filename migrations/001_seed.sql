
INSERT OR IGNORE INTO members(member_number,full_name,cert_level,type3_driver,type2_driver,phone,email,role,active) VALUES
('1001','Grace Lee','ALS',1,1,'+19105550101','grace@example.com','member',1),
('1002','Chris Smith','EMT-B',0,1,'+19105550102','chris@example.com','member',1),
('2001','Duty Supervisor','ALS',1,1,'+19105550999','super@example.com','supervisor',1);

INSERT INTO wallboard(service_date,block,unit_id,seat_role,status,quality,flashing)
VALUES ('2025-10-24','night','120','Driver','open','red','red'),
       ('2025-10-24','night','120','Attendant','open','red','red');
