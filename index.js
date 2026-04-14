require('dotenv').config();
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const cheerio = require('cheerio');

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'grades.json');
const DEBUG_HTML_FILE = path.join(DATA_DIR, 'last-response.html');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const hasMailConfig = Boolean(process.env.SMTP_USER && process.env.SMTP_PASS && process.env.RECIPIENTS);
const transporter = hasMailConfig
    ? nodemailer.createTransport({
        service: 'gmail',
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    })
    : null;

function getRecipients() {
    return (process.env.RECIPIENTS || '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .join(',');
}

function gradeLooksNumeric(raw) {
    if (raw === null || raw === undefined) return false;
    return /^\d+(?:[.,]\d+)?$/.test(raw.trim().replace(',', '.').replace('*', ''));
}

// Adapted from the working Panum-Grades content.js extension logic.
// Step 1: Find subject header rows (rows with <b>CODE</b><br>Name, NOT inside table.clean)
// Step 2: Find detail rows (class contains _detailrow), parse table.clean for individual tests
// Columns in detail table: Datum | Thema | Bewertung | Gewichtung | Klassenschnitt
function parseAllFromHtml(html) {
    const $ = cheerio.load(html);
    const subjects = {};

    // Step 1: Collect all subject header rows
    $('tr').each((_, row) => {
        const $row = $(row);
        // Skip rows inside detail tables (table.clean)
        if ($row.closest('table.clean').length > 0) return;

        const tds = $row.find('> td');
        if (tds.length < 2) return;

        const firstTd = $(tds[0]);
        const boldEl = firstTd.find('b');
        if (boldEl.length === 0) return;

        const code = boldEl.text().trim();
        if (code.length === 0) return;

        // Subject name: full td text minus the code
        const fullText = firstTd.text().trim();
        const name = fullText.replace(code, '').trim();
        if (name.length === 0) return;

        // Average from second td
        const avgRaw = $(tds[1]).text().trim().replace(',', '.').replace('*', '').trim();
        const hasAverage = gradeLooksNumeric(avgRaw);

        subjects[code] = {
            code,
            name,
            average: hasAverage ? avgRaw : null,
            tests: []
        };
    });

    // Step 2: Find detail rows and parse individual test grades
    $('tr').each((_, row) => {
        const $row = $(row);
        const cls = $row.attr('class') || '';
        if (cls.indexOf('_detailrow') === -1) return;

        const detailTable = $row.find('table.clean');
        if (detailTable.length === 0) return;

        // Previous sibling tr has the subject info
        const prevRow = $row.prev('tr');
        if (prevRow.length === 0) return;

        const boldEl = prevRow.find('td:first-child b');
        if (boldEl.length === 0) return;

        const code = boldEl.text().trim();
        if (code.length === 0 || subjects[code] === undefined) return;

        // Parse test rows (same approach as content.js extractNotenFromTable)
        detailTable.find('tbody > tr').each((_, testRow) => {
            const tds = $(testRow).find('> td');
            if (tds.length < 4) return;

            // Skip colspan rows (Aktueller Durchschnitt summary)
            if ($(tds[0]).attr('colspan')) return;

            const dateText = $(tds[0]).text().trim();
            const topic = $(tds[1]).text().trim();

            // Skip header row and durchschnitt rows
            if (/^datum$/i.test(dateText)) return;
            if (/durchschnitt/i.test(topic) || /durchschnitt/i.test(dateText)) return;

            // Grade in col 2 - may contain tooltip spans, parseFloat handles that
            const gradeText = $(tds[2]).text().trim().replace(',', '.').replace('*', '');
            const gradeNum = parseFloat(gradeText);
            const weightText = $(tds[3]).text().trim().replace(',', '.');
            const weightNum = parseFloat(weightText);

            // Only include tests with a valid numeric grade
            if (isNaN(gradeNum) || isNaN(weightNum)) return;

            const classAvg = tds.length > 4 ? $(tds[4]).text().trim().replace(',', '.').trim() : '';

            subjects[code].tests.push({
                date: dateText,
                topic: topic,
                grade: gradeNum.toString(),
                weight: weightText,
                classAvg: classAvg
            });
        });
    });

    return subjects;
}

function findLoginForm($) {
    return $('form').filter((_, form) => {
        const formEl = $(form);
        return formEl.find('#user, input[name="user"]').length > 0
            && formEl.find('#passwort, input[name="passwort"], input[type="password"]').length > 0;
    }).first();
}

function buildLoginPayload(form, $) {
    const payload = {};
    form.find('input').each((_, input) => {
        const inputEl = $(input);
        const type = (inputEl.attr('type') || 'text').toLowerCase();
        const key = inputEl.attr('name') || inputEl.attr('id');
        if (!key) return;

        if ((type === 'checkbox' || type === 'radio') && !inputEl.is(':checked')) return;

        payload[key] = inputEl.val() || '';
    });

    const userField = form.find('input[name="user"]').attr('name')
        || form.find('#user').attr('name')
        || 'user';
    const passField = form.find('input[name="passwort"]').attr('name')
        || form.find('#passwort').attr('name')
        || 'passwort';

    payload[userField] = process.env.SN_USER || '';
    payload[passField] = process.env.SN_PASS || '';

    return payload;
}

// Compare old and new data, return structured changes
function findChanges(oldData, newData) {
    const changes = [];

    for (const [code, subj] of Object.entries(newData)) {
        const oldSubj = oldData[code];

        if (!oldSubj) {
            // Entirely new subject (only report if it has grades)
            if (subj.average || subj.tests.length > 0) {
                changes.push({
                    type: 'new_subject',
                    code,
                    name: subj.name,
                    average: subj.average,
                    tests: subj.tests
                });
            }
            continue;
        }

        // Check for new individual tests
        for (const test of subj.tests) {
            const isNew = !oldSubj.tests.some(
                (old) => old.topic === test.topic && old.grade === test.grade
            );
            if (isNew) {
                changes.push({
                    type: 'new_test',
                    code,
                    name: subj.name,
                    test
                });
            }
        }

        // Check if average changed
        if (oldSubj.average !== subj.average && subj.average) {
            changes.push({
                type: 'avg_changed',
                code,
                name: subj.name,
                oldAverage: oldSubj.average,
                newAverage: subj.average
            });
        }
    }

    return changes;
}

function gradeColor(grade) {
    const g = parseFloat(grade);
    if (isNaN(g)) return '#666';
    if (g >= 5.5) return '#2e7d32';
    if (g >= 4.5) return '#558b2f';
    if (g >= 4.0) return '#f57f17';
    return '#c62828';
}

function formatEmailHtml(changes) {
    // Group changes by subject name
    const bySubject = {};
    for (const c of changes) {
        const key = c.name;
        if (!bySubject[key]) bySubject[key] = [];
        bySubject[key].push(c);
    }

    let html = `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">`;
    html += `<div style="background: linear-gradient(135deg, #1565c0, #1976d2); color: white; padding: 20px 24px; border-radius: 12px 12px 0 0;">`;
    html += `<h2 style="margin: 0; font-size: 20px;">📚 Neue Noten auf Schulnetz</h2>`;
    html += `</div>`;

    for (const [subject, subjectChanges] of Object.entries(bySubject)) {
        html += `<div style="background: #f8f9fa; border: 1px solid #e0e0e0; border-top: none; padding: 16px 24px;">`;
        html += `<h3 style="margin: 0 0 12px 0; color: #1565c0; font-size: 17px;">📖 ${subject}</h3>`;

        for (const c of subjectChanges) {
            if (c.type === 'new_subject') {
                html += `<div style="background: #e8f5e9; padding: 8px 12px; border-radius: 6px; margin-bottom: 8px; font-size: 13px; color: #2e7d32;">✨ Neues Fach!</div>`;
                for (const t of c.tests) {
                    html += `<div style="background: white; padding: 10px 14px; border-radius: 8px; margin-bottom: 6px; border-left: 4px solid ${gradeColor(t.grade)};">`;
                    html += `<div style="font-weight: 600;">${t.topic}</div>`;
                    html += `<div style="margin-top: 4px;"><span style="font-size: 22px; font-weight: 700; color: ${gradeColor(t.grade)};">${t.grade}</span>`;
                    if (t.weight && t.weight !== '1') html += ` <span style="color: #999; font-size: 12px;">Gewicht: ${t.weight}</span>`;
                    if (t.date) html += ` <span style="color: #999; font-size: 12px;">· ${t.date}</span>`;
                    html += `</div></div>`;
                }
                if (c.average) {
                    html += `<div style="text-align: center; padding: 8px; color: #666; font-size: 14px;">Schnitt: <strong style="color: ${gradeColor(c.average)};">${c.average}</strong></div>`;
                }
            } else if (c.type === 'new_test') {
                html += `<div style="background: white; padding: 10px 14px; border-radius: 8px; margin-bottom: 6px; border-left: 4px solid ${gradeColor(c.test.grade)};">`;
                html += `<div style="font-weight: 600;">✏️ ${c.test.topic}</div>`;
                html += `<div style="margin-top: 4px;"><span style="font-size: 22px; font-weight: 700; color: ${gradeColor(c.test.grade)};">${c.test.grade}</span>`;
                if (c.test.weight && c.test.weight !== '1') html += ` <span style="color: #999; font-size: 12px;">Gewicht: ${c.test.weight}</span>`;
                if (c.test.date) html += ` <span style="color: #999; font-size: 12px;">· ${c.test.date}</span>`;
                html += `</div>`;
                if (c.test.classAvg && c.test.classAvg.trim() !== '--' && c.test.classAvg.trim().length > 0) {
                    html += `<div style="margin-top: 4px; font-size: 12px; color: #888;">Klassenschnitt: ${c.test.classAvg.trim()}</div>`;
                }
                html += `</div>`;
            } else if (c.type === 'avg_changed') {
                const oldNum = parseFloat(c.oldAverage);
                const newNum = parseFloat(c.newAverage);
                const arrow = newNum > oldNum ? '📈' : newNum < oldNum ? '📉' : '➡️';
                const bgColor = newNum > oldNum ? '#e8f5e9' : newNum < oldNum ? '#fbe9e7' : '#fff3e0';
                if (c.oldAverage) {
                    html += `<div style="background: ${bgColor}; padding: 10px 14px; border-radius: 8px; margin-bottom: 6px; text-align: center;">`;
                    html += `${arrow} Neuer Schnitt: <span style="text-decoration: line-through; color: #999;">${c.oldAverage}</span> → <strong style="color: ${gradeColor(c.newAverage)};">${c.newAverage}</strong>`;
                    html += `</div>`;
                } else {
                    html += `<div style="background: #e3f2fd; padding: 10px 14px; border-radius: 8px; margin-bottom: 6px; text-align: center;">`;
                    html += `📊 Schnitt: <strong style="color: ${gradeColor(c.newAverage)};">${c.newAverage}</strong>`;
                    html += `</div>`;
                }
            }
        }
        html += `</div>`;
    }

    html += `<div style="background: #f0f0f0; border: 1px solid #e0e0e0; border-top: none; padding: 12px 24px; border-radius: 0 0 12px 12px; text-align: center; font-size: 11px; color: #999;">`;
    html += `Schulnetz Monitor · automatisch generiert`;
    html += `</div></div>`;

    return html;
}

function formatEmailText(changes) {
    const lines = [];
    const bySubject = {};
    for (const c of changes) {
        const key = c.name;
        if (!bySubject[key]) bySubject[key] = [];
        bySubject[key].push(c);
    }

    for (const [subject, subjectChanges] of Object.entries(bySubject)) {
        lines.push(`Neue Note in ${subject}!`);
        lines.push('─'.repeat(30));
        for (const c of subjectChanges) {
            if (c.type === 'new_test') {
                lines.push(`  Prüfung "${c.test.topic}": ${c.test.grade}${c.test.weight && c.test.weight !== '1' ? ` [Gewicht: ${c.test.weight}]` : ''}${c.test.date ? ` (${c.test.date})` : ''}`);
            } else if (c.type === 'avg_changed') {
                const arrow = parseFloat(c.newAverage) > parseFloat(c.oldAverage) ? '↑' : '↓';
                lines.push(`  Neuer Schnitt: ${c.oldAverage || '--'} ${arrow} ${c.newAverage}`);
            } else if (c.type === 'new_subject') {
                lines.push(`  Neues Fach!`);
                for (const t of c.tests) lines.push(`  - ${t.topic}: ${t.grade}`);
                if (c.average) lines.push(`  Schnitt: ${c.average}`);
            }
        }
        lines.push('');
    }
    return lines.join('\n');
}

async function sendChangesMail(changes) {
    if (!transporter) {
        console.log('Mail skipped: SMTP_USER/SMTP_PASS/RECIPIENTS not fully configured.');
        return;
    }

    const htmlBody = formatEmailHtml(changes);
    const textBody = formatEmailText(changes);

    // Build a short subject line listing affected subjects
    const affectedSubjects = [...new Set(changes.map((c) => c.name))];
    const newTestCount = changes.filter((c) => c.type === 'new_test' || c.type === 'new_subject').length;
    const subjectLine = newTestCount > 0
        ? `KSA Schulnetz: Neue Note${newTestCount > 1 ? 'n' : ''} in ${affectedSubjects.join(', ')}`
        : `KSA Schulnetz: Notenänderung in ${affectedSubjects.join(', ')}`;

    await transporter.sendMail({
        from: process.env.SMTP_USER,
        to: getRecipients(),
        subject: subjectLine,
        text: textBody,
        html: htmlBody
    });
}

// Migrate old flat array format to new code-keyed format
function migrateOldData(oldArray) {
    const subjects = {};
    for (const entry of oldArray) {
        if (/^aktueller\s+durchschnitt/i.test(entry.subject)) continue;
        // Old format had combined code+name like "BI-M2a-KüRBiologie"
        // Try to extract code (up to first known subject name pattern)
        const fullText = entry.subject;
        const codeMatch = fullText.match(/^([A-Z]{2,}[-\w().\s]*?)(?=[A-ZÄÖÜ][a-zäöü])/);
        const code = codeMatch ? codeMatch[1] : fullText;
        const name = fullText.replace(code, '').trim() || fullText;
        subjects[code] = {
            code,
            name,
            average: entry.grade,
            tests: []
        };
    }
    return subjects;
}

function loadSavedData() {
    if (!fs.existsSync(DATA_FILE)) return {};
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (Array.isArray(raw)) return migrateOldData(raw);
    return raw;
}

async function scrape() {
    console.log(`[${new Date().toISOString()}] Scrape started.`);
    let lastHtml = '';
    try {
        if (!process.env.SN_USER || !process.env.SN_PASS) {
            throw new Error('SN_USER and SN_PASS must be set in .env');
        }

        const jar = new CookieJar();
        const client = wrapper(axios.create({
            jar,
            withCredentials: true,
            timeout: 30000,
            maxRedirects: 5,
            headers: {
                'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) SchulnetzMonitor/2.0',
                'Accept-Language': 'de-CH,de;q=0.9,en;q=0.8'
            }
        }));

        const loginUrl = "https://www.schul-netz.com/ausserschwyz/loginto.php?pageid=21311&mode=0&lang=";
        console.log('Requesting login page...');
        const loginPageResp = await client.get(loginUrl);
        lastHtml = loginPageResp.data;

        const loginPage = cheerio.load(loginPageResp.data);
        const loginForm = findLoginForm(loginPage);
        if (!loginForm || loginForm.length === 0) {
            throw new Error('Login form not found. Site layout likely changed.');
        }

        const actionAttr = loginForm.attr('action') || loginUrl;
        const submitUrl = new URL(actionAttr, loginUrl).toString();
        const method = (loginForm.attr('method') || 'POST').toUpperCase();
        const payload = buildLoginPayload(loginForm, loginPage);

        console.log('Submitting login form...');
        const submitResp = await client.request({
            url: submitUrl,
            method,
            data: new URLSearchParams(payload).toString(),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        lastHtml = typeof submitResp.data === 'string' ? submitResp.data : '';
        const postLoginPage = cheerio.load(lastHtml);
        if (findLoginForm(postLoginPage).length > 0) {
            throw new Error('Login did not succeed (login form still present after submit).');
        }

        // The grades page (pageid=21311) has all subjects + detail rows on one page
        let subjects = parseAllFromHtml(lastHtml);
        if (Object.keys(subjects).length === 0) {
            const gradesLink = postLoginPage('a[href*="note"], a[href*="Noten"], a:contains("Noten")').first().attr('href');
            if (gradesLink) {
                const gradesUrl = new URL(gradesLink, loginUrl).toString();
                console.log(`No grades on landing page, trying ${gradesUrl}`);
                const gradesResp = await client.get(gradesUrl);
                lastHtml = typeof gradesResp.data === 'string' ? gradesResp.data : '';
                subjects = parseAllFromHtml(lastHtml);
            }
        }

        if (Object.keys(subjects).length === 0) {
            console.log('No subjects detected. Saved HTML response for debugging.');
            fs.writeFileSync(DEBUG_HTML_FILE, lastHtml, 'utf8');
        } else {
            const totalTests = Object.values(subjects).reduce((sum, s) => sum + s.tests.length, 0);
            console.log(`Detected ${Object.keys(subjects).length} subjects with ${totalTests} graded tests.`);

            for (const [code, subj] of Object.entries(subjects)) {
                if (subj.tests.length > 0) {
                    console.log(`  ${subj.name} (${code}): ${subj.tests.length} test(s), avg: ${subj.average || '--'}`);
                    for (const t of subj.tests) {
                        console.log(`    - ${t.topic}: ${t.grade} (${t.date})`);
                    }
                }
            }

            const oldData = loadSavedData();
            const changes = findChanges(oldData, subjects);

            if (changes.length > 0) {
                console.log(`\nFound ${changes.length} change(s). Sending email...`);
                console.log(formatEmailText(changes));
                await sendChangesMail(changes);
            } else {
                console.log('No new grades since last check.');
            }

            // Always save current state
            fs.writeFileSync(DATA_FILE, JSON.stringify(subjects, null, 2));
        }

    } catch (error) {
        console.error('Scrape failed:', error.message);
        if (lastHtml) {
            fs.writeFileSync(DEBUG_HTML_FILE, lastHtml, 'utf8');
            console.log(`Saved debug HTML to ${DEBUG_HTML_FILE}`);
        }
    }
}

// Check every X minutes based on .env
const checkInterval = (parseInt(process.env.CHECK_INTERVAL) || 15) * 60 * 1000;
console.log(`Monitor started. Interval: ${process.env.CHECK_INTERVAL}m`);
setInterval(scrape, checkInterval);
scrape();
