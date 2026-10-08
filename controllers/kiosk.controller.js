const db = require('../config/db');
const moment = require('moment-timezone');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getCompanyTimezone, determinePunchStatus } = require('../utils/attendanceHelper');

const euclideanDistance = (desc1, desc2) => {
    if (desc1.length !== desc2.length) return Infinity;
    return Math.sqrt(
        desc1.reduce((sum, val, i) => sum + Math.pow(val - desc2[i], 2), 0)
    );
};

const FACE_MATCH_THRESHOLD = 0.45;

exports.getKioskSettings = async (req, res) => {
    try {
        const { company_id } = req.user;
        const [settings] = await db.execute(
            'SELECT * FROM kiosk_settings WHERE company_id = ?',
            [company_id]
        );

        if (settings.length === 0) {
            return res.json({
                kiosk_name: 'Reception Tablet A',
                branch: '',
                status: 'Active',
                face_recognition: 1,
                kiosk_pin: '1234'
            });
        }

        const data = settings[0];
        data.face_recognition = data.face_recognition !== undefined && data.face_recognition !== null ? Number(data.face_recognition) : 1;
        data.kiosk_pin = data.kiosk_pin || '1234';
        res.json(data);
    } catch (err) {
        console.error('Error fetching kiosk settings:', err);
        res.status(500).json({ message: 'Server error fetching kiosk settings', error: err.message });
    }
};

exports.updateKioskSettings = async (req, res) => {
    try {
        const { company_id } = req.user;
        const { kiosk_name, branch, status, face_recognition, kiosk_pin } = req.body;

        const faceVal = (face_recognition === 1 || face_recognition === true || face_recognition === '1' || face_recognition === 'ON') ? 1 : 0;
        const pinVal = kiosk_pin !== undefined && kiosk_pin !== null && String(kiosk_pin).trim() !== ''
            ? String(kiosk_pin).trim()
            : '1234';

        const [settings] = await db.execute(
            'SELECT id FROM kiosk_settings WHERE company_id = ?',
            [company_id]
        );

        if (settings.length === 0) {
            await db.execute(
                'INSERT INTO kiosk_settings (company_id, kiosk_name, branch, status, face_recognition, kiosk_pin) VALUES (?, ?, ?, ?, ?, ?)',
                [company_id, kiosk_name || 'Reception Tablet A', branch || '', status || 'Active', faceVal, pinVal]
            );
        } else {
            await db.execute(
                'UPDATE kiosk_settings SET kiosk_name = ?, branch = ?, status = ?, face_recognition = ?, kiosk_pin = ? WHERE company_id = ?',
                [kiosk_name || 'Reception Tablet A', branch || '', status || 'Active', faceVal, pinVal, company_id]
            );
        }

        res.json({ message: 'Kiosk settings updated successfully', kiosk_pin: pinVal });
    } catch (err) {
        console.error('Error updating kiosk settings:', err);
        res.status(500).json({ message: 'Server error updating kiosk settings', error: err.message });
    }
};

exports.kioskPunch = async (req, res) => {
    try {
        const { employeeId, type } = req.body;

        if (!employeeId || !type) {
             return res.status(400).json({ message: 'Employee ID and punch type are required' });
        }

        // Validate employee exists
        let empSql = 'SELECT * FROM employees WHERE (custom_id = ? OR machine_id = ? OR id = ?)';
        let empParams = [employeeId, employeeId, employeeId];
        if (req.user?.company_id && req.user.role !== 'MasterAdmin') {
            empSql += ' AND company_id = ?';
            empParams.push(req.user.company_id);
        }
        const [employees] = await db.execute(empSql, empParams);

        if (employees.length === 0) {
            return res.status(404).json({ message: 'Employee not found' });
        }

        const employee = employees[0];
        const date = new Date().toISOString().split('T')[0];
        const now = new Date();

        // Find existing attendance record for today
        const [attendance] = await db.execute(
            'SELECT * FROM attendance WHERE employee_id = ? AND date = ?',
            [employee.id, date]
        );

        let uiStatus = 'On Time';

        if (type === 'Punch In') {
            if (attendance.length > 0 && attendance[0].in_time) {
                return res.status(400).json({ message: 'Already punched in today' });
            }

            if (attendance.length === 0) {
                const status = await determinePunchStatus(employee.company_id, now.toISOString());
                uiStatus = status === 'late' ? 'Late' : 'On Time';
                await db.execute(
                    'INSERT INTO attendance (company_id, employee_id, date, in_time, status) VALUES (?, ?, ?, ?, ?)',
                    [employee.company_id, employee.id, date, now, status]
                );
            } else {
                 const status = await determinePunchStatus(employee.company_id, now.toISOString());
                 uiStatus = status === 'late' ? 'Late' : 'On Time';
                 await db.execute(
                    'UPDATE attendance SET in_time = ?, status = ? WHERE id = ?',
                    [now, status, attendance[0].id]
                );
            }
        } else if (type === 'Punch Out') {
            if (attendance.length === 0 || !attendance[0].in_time) {
                 return res.status(400).json({ message: 'Cannot punch out without punching in first' });
            }
            
            if (attendance[0].out_time) {
                 return res.status(400).json({ message: 'Already punched out today' });
            }

            const inTime = new Date(attendance[0].in_time);
            const diffHours = (now - inTime) / (1000 * 60 * 60);

            await db.execute(
                'UPDATE attendance SET out_time = ?, total_hours = ? WHERE id = ?',
                [now, diffHours.toFixed(2), attendance[0].id]
            );
            uiStatus = `${diffHours.toFixed(1)} hrs worked`;
        } else {
            return res.status(400).json({ message: 'Invalid punch type' });
        }

        res.json({ 
            success: true,
            message: `${type} successful for ${employee.name}`,
            employee: { name: employee.name, custom_id: employee.custom_id, department: employee.department || 'N/A' },
            log: { action: type, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), status: uiStatus, device: 'Kiosk Mode' }
        });

    } catch (err) {
        console.error('Error processing kiosk punch:', err);
        res.status(500).json({ message: 'Server error processing punch', error: err.message });
    }
};

exports.kioskFacePunch = async (req, res) => {
    try {
        const { company_id } = req.user;
        const { descriptor, livenessPassed, livenessScore } = req.body;

        // Check if Face Recognition is enabled for this company
        const [kioskConf] = await db.execute(
            'SELECT face_recognition FROM kiosk_settings WHERE company_id = ?',
            [company_id]
        );
        if (kioskConf.length > 0 && Number(kioskConf[0].face_recognition) === 0) {
            return res.status(403).json({ message: 'Face recognition attendance is disabled for this company.' });
        }

        if (!descriptor || !Array.isArray(descriptor)) {
            return res.status(400).json({ message: 'Invalid face descriptor.' });
        }
        
        if (!livenessPassed || livenessScore < 0.80) {
            return res.status(403).json({ message: 'Anti-spoofing triggered. Real face not detected.' });
        }

        let query = `
            SELECT fe.employee_id, fe.descriptor, e.name, e.custom_id, e.company_id
            FROM face_embeddings fe
            JOIN employees e ON fe.employee_id = e.id
            WHERE e.status = 'active'
        `;
        let params = [];

        if (req.user.role !== 'MasterAdmin') {
            query += ' AND e.company_id = ?';
            params.push(company_id);
        }

        // Fetch all face embeddings for the company (or all if MasterAdmin)
        const [embeddings] = await db.execute(query, params);

        if (embeddings.length === 0) {
            return res.status(400).json({ message: 'No registered faces found for this company.' });
        }

        let bestMatch = null;
        let minDistance = Infinity;

        for (const row of embeddings) {
            const storedDescriptor = typeof row.descriptor === 'string' ? JSON.parse(row.descriptor) : row.descriptor;
            const distance = euclideanDistance(descriptor, storedDescriptor);
            if (distance < minDistance) {
                minDistance = distance;
                bestMatch = row;
            }
        }

        if (minDistance <= FACE_MATCH_THRESHOLD && bestMatch) {
            const employeeId = bestMatch.employee_id;
            const tz = await getCompanyTimezone(bestMatch.company_id);
            const nowFormatted = moment().tz(tz).format("YYYY-MM-DD HH:mm:ss");
            const todayFormatted = moment().tz(tz).format("YYYY-MM-DD");

            await db.execute('INSERT INTO face_logs (employee_id, status, confidence) VALUES (?, ?, ?)', [employeeId, 'success', minDistance]);

            // Find existing attendance record for today
            const [attendance] = await db.execute(
                'SELECT * FROM attendance WHERE employee_id = ? AND date = ?',
                [employeeId, todayFormatted]
            );

            let action = 'Punch In';

            let uiStatus = 'On Time';

            if (attendance.length === 0) {
                // Punch In
                const status = await determinePunchStatus(bestMatch.company_id, nowFormatted);
                uiStatus = status === 'late' ? 'Late' : 'On Time';
                await db.execute(
                    'INSERT INTO attendance (company_id, employee_id, date, in_time, status) VALUES (?, ?, ?, ?, ?)',
                    [bestMatch.company_id, employeeId, todayFormatted, nowFormatted, status]
                );
            } else if (!attendance[0].out_time) {
                // Punch Out
                action = 'Punch Out';
                
                const inTimeStr = attendance[0].in_time; 
                const inTime = moment.tz(inTimeStr, "YYYY-MM-DD HH:mm:ss", tz);
                const outTime = moment.tz(nowFormatted, "YYYY-MM-DD HH:mm:ss", tz);
                
                const diffMs = outTime.diff(inTime);
                const totalHours = (diffMs / (1000 * 60 * 60)).toFixed(2);

                await db.execute(
                    'UPDATE attendance SET out_time = ?, total_hours = ? WHERE id = ?',
                    [nowFormatted, totalHours, attendance[0].id]
                );
            } else {
                return res.status(400).json({ message: 'Already punched out for today.' });
            }

            return res.json({ 
                success: true, 
                message: `${action} successful for ${bestMatch.name}`,
                employee: { name: bestMatch.name, custom_id: bestMatch.custom_id, department: 'N/A' },
                log: { action, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), status: uiStatus, device: 'Kiosk Face Scanner' }
            });
        } else {
            await db.execute('INSERT INTO unknown_attempts (confidence) VALUES (?)', [minDistance]);
            return res.status(400).json({ message: 'Face match failed. Please try again.' });
        }
    } catch (err) {
        console.error('Error processing kiosk face punch:', err);
        res.status(500).json({ message: 'Server error processing face punch', error: err.message });
    }
};

// --- STANDALONE KIOSK CONTROLLERS ---

/**
 * Standalone Kiosk Device Login / Activation
 * Authenticates company once and returns a long-lived restricted Kiosk token (role: 'kiosk')
 */
exports.kioskLogin = async (req, res) => {
    try {
        const { email, password, deviceName } = req.body;

        if (!email || !password) {
            return res.status(400).json({ message: 'Company email and password are required' });
        }

        // 1. Find user (admin or company owner)
        const [users] = await db.execute(
            'SELECT id, name, email, password, role, company_id FROM users WHERE email = ?',
            [email.trim().toLowerCase()]
        );

        if (users.length === 0) {
            return res.status(401).json({ message: 'Invalid company credentials' });
        }

        const user = users[0];

        // 2. Verify password: check dedicated Kiosk PIN first, or Admin master password
        let isAuthorized = false;

        if (user.company_id) {
            const [kSettings] = await db.execute(
                'SELECT kiosk_pin FROM kiosk_settings WHERE company_id = ?',
                [user.company_id]
            );
            const activePin = kSettings.length > 0 && kSettings[0].kiosk_pin ? String(kSettings[0].kiosk_pin).trim() : '1234';
            if (String(password).trim() === activePin) {
                isAuthorized = true;
            }
        }

        if (!isAuthorized) {
            const isMatch = await bcrypt.compare(password, user.password);
            if (isMatch) {
                isAuthorized = true;
            }
        }

        if (!isAuthorized) {
            return res.status(401).json({ message: 'Invalid Kiosk PIN or admin password' });
        }

        if (!user.company_id) {
            return res.status(400).json({ message: 'No company associated with this account' });
        }

        // 3. Verify company exists and is active
        const [companies] = await db.execute(
            'SELECT id, company_name, status FROM companies WHERE id = ?',
            [user.company_id]
        );

        if (companies.length === 0) {
            return res.status(404).json({ message: 'Company not found' });
        }

        const company = companies[0];
        if (company.status && company.status.toLowerCase() !== 'active') {
            return res.status(403).json({ message: 'Company account is inactive or suspended' });
        }

        // 4. Issue dedicated long-lived Kiosk JWT (role: 'kiosk', 365d)
        const token = jwt.sign(
            {
                id: `kiosk-${company.id}`,
                role: 'kiosk',
                company_id: company.id,
                company_name: company.company_name,
                device_name: deviceName || 'Reception Tablet'
            },
            process.env.JWT_SECRET || 'biotrack_secret_key_2026_pro',
            { expiresIn: '365d' }
        );

        // 5. Fetch kiosk settings
        const [settings] = await db.execute(
            'SELECT * FROM kiosk_settings WHERE company_id = ?',
            [company.id]
        );

        const kioskConfig = settings.length > 0 ? settings[0] : {
            kiosk_name: deviceName || 'Reception Tablet A',
            face_recognition: 1,
            status: 'Active'
        };

        // Fetch company active geofences / branches if any
        const [branches] = await db.execute(
            'SELECT id, name, address FROM geofences WHERE company_id = ? AND status = "Active"',
            [company.id]
        );

        res.json({
            success: true,
            message: 'Kiosk Terminal activated successfully',
            token,
            company: {
                id: company.id,
                name: company.company_name
            },
            settings: kioskConfig,
            branches
        });
    } catch (err) {
        console.error('Error activating kiosk:', err);
        res.status(500).json({ message: 'Server error activating kiosk', error: err.message });
    }
};

/**
 * Verify single employee ID for PIN punch (Lightweight, zero data leakage)
 */
exports.verifyEmployee = async (req, res) => {
    try {
        const { employeeId } = req.body;
        const company_id = req.user?.company_id;

        if (!employeeId) {
            return res.status(400).json({ message: 'Employee ID is required' });
        }

        // Query employee belonging to this company
        let query = 'SELECT id, custom_id, machine_id, name, department, photo, status FROM employees WHERE (custom_id = ? OR machine_id = ? OR id = ?)';
        let params = [employeeId.trim(), employeeId.trim(), employeeId.trim()];

        if (company_id && req.user.role !== 'MasterAdmin') {
            query += ' AND company_id = ?';
            params.push(company_id);
        }

        const [employees] = await db.execute(query, params);

        if (employees.length === 0) {
            return res.status(404).json({ message: 'Employee ID not found' });
        }

        const emp = employees[0];
        if (emp.status !== 'active') {
            return res.status(400).json({ message: 'Employee profile is currently inactive' });
        }

        // Check today's attendance status
        const todayDate = new Date().toISOString().split('T')[0];
        const [attendance] = await db.execute(
            'SELECT id, in_time, out_time FROM attendance WHERE employee_id = ? AND date = ?',
            [emp.id, todayDate]
        );

        let punchStatus = 'needs_checkin';
        if (attendance.length > 0 && attendance[0].in_time && !attendance[0].out_time) {
            punchStatus = 'needs_checkout';
        } else if (attendance.length > 0 && attendance[0].in_time && attendance[0].out_time) {
            punchStatus = 'done';
        }

        res.json({
            success: true,
            employee: {
                id: emp.id,
                custom_id: emp.custom_id,
                name: emp.name,
                department: emp.department || 'General',
                photo: emp.photo
            },
            punchStatus
        });
    } catch (err) {
        console.error('Error verifying employee on kiosk:', err);
        res.status(500).json({ message: 'Server error verifying employee', error: err.message });
    }
};

/**
 * Admin Exit/Deactivate Kiosk Screen (Requires admin password to exit/reconfigure)
 */
exports.kioskExit = async (req, res) => {
    try {
        const { password, action } = req.body;
        const company_id = req.user?.company_id;

        if (!password) {
            return res.status(400).json({ message: 'Admin password is required to exit Kiosk' });
        }

        // Check dedicated Kiosk PIN first
        let isAuthorized = false;

        const [kSettings] = await db.execute(
            'SELECT kiosk_pin FROM kiosk_settings WHERE company_id = ?',
            [company_id]
        );
        const activePin = kSettings.length > 0 && kSettings[0].kiosk_pin ? String(kSettings[0].kiosk_pin).trim() : '1234';
        if (String(password).trim() === activePin) {
            isAuthorized = true;
        }

        // Fallback: Check admin users' master passwords
        if (!isAuthorized) {
            const [admins] = await db.execute(
                'SELECT password FROM users WHERE company_id = ? AND role IN ("admin", "masteradmin", "superadmin")',
                [company_id]
            );

            for (const admin of admins) {
                if (await bcrypt.compare(password, admin.password)) {
                    isAuthorized = true;
                    break;
                }
            }
        }

        if (!isAuthorized) {
            return res.status(401).json({ message: 'Incorrect Kiosk PIN or admin password' });
        }

        if (action === 'verify') {
            return res.json({ success: true, message: 'Admin verified successfully' });
        }

        res.json({ success: true, message: 'Kiosk deactivated successfully' });
    } catch (err) {
        console.error('Error during kiosk exit:', err);
        res.status(500).json({ message: 'Server error during kiosk exit', error: err.message });
    }
};

