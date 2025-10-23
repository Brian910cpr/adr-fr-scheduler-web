INSERT OR IGNORE INTO members(member_number,full_name,cert_level,type3_driver) VALUES
('1001','Grace Lee','Paramedic',1),
('1002','Chris Smith','EMT-B',0),
('1003','Jordan MR','MR',1),
('1004','Avery AEMT','AEMT',1);
INSERT OR IGNORE INTO wallboard(service_date,block,unit_id,seat_role,status,quality,flashing) VALUES
('2025-10-24','day','120','Driver','open','red','red'),
('2025-10-24','day','120','Attendant','open','red','red'),
('2025-10-24','night','120','Driver','open','red','red'),
('2025-10-24','night','120','Attendant','open','red','red'),
('2025-10-24','day','121','Driver','open','red','red'),
('2025-10-24','day','121','Attendant','open','red','red'),
('2025-10-24','night','121','Driver','open','red','red'),
('2025-10-24','night','121','Attendant','open','red','red');
INSERT OR IGNORE INTO units_active(service_date,unit_id,am_active,pm_active) VALUES
('2025-10-24','120',1,1),
('2025-10-24','121',1,1),
('2025-10-24','123',0,0);
