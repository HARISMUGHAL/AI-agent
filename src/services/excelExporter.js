'use strict';

const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sanitizeSpreadsheetValue, safeHyperlink } = require('../utils/formulaSanitizer');

const US_COLUMNS = [
  ['lead_id','Lead ID'],['business_name','Business Name'],['category','Category'],['phone','Phone'],['public_email','Public Email'],
  ['website','Website'],['address','Address'],['city','City'],['state','State'],['country','Country'],
  ['primary_source_url','Primary Source URL'],['secondary_source_url','Secondary Source URL'],['website_status','Website Status'],
  ['website_problems','Website Problems'],['website_evidence','Website Evidence'],['ai_opportunity','AI Opportunity'],
  ['recommended_service','Recommended Service'],['lead_score','Lead Score'],['priority','Priority'],['verification_status','Verification Status'],
  ['audit_timestamp','Audit Timestamp'],['date_collected','Date Collected'],['notes','Notes']
];

const UK_COLUMNS = [
  ['lead_id','Lead ID'],['business_name','Business Name'],['trading_name','Trading Name'],['category','Category'],['business_type','Business Type'],
  ['company_number','Company Number'],['verified_director_name','Verified Director Name'],['owner_verification','Owner Verification'],
  ['contact_person','Contact Person'],['business_phone','Business Phone'],['phone_type','Phone Type'],['alternate_phone','Alternate Phone'],
  ['business_email','Business Email'],['alternate_email','Alternate Email'],['website','Website'],['contact_page','Contact Page'],
  ['address','Address'],['city','City'],['region','Region'],['postcode','Postcode'],['country','Country'],['primary_source','Primary Source'],
  ['primary_source_url','Primary Source URL'],['secondary_source','Secondary Source'],['secondary_source_url','Secondary Source URL'],
  ['companies_house_url','Companies House URL'],['phone_source_url','Phone Source URL'],['email_source_url','Email Source URL'],
  ['owner_source_url','Owner Source URL'],['confidence_score','Confidence Score'],['confidence_level','Confidence Level'],
  ['verification_status','Verification Status'],['date_collected','Date Collected'],['notes','Notes']
];

function karachiDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: process.env.DATA_COLLECTION_TIMEZONE || 'Asia/Karachi', year:'numeric', month:'2-digit', day:'2-digit' }).format(date);
}

function valueForCell(value) {
  if (Array.isArray(value) || (value && typeof value === 'object' && !(value instanceof Date))) value = JSON.stringify(value);
  return sanitizeSpreadsheetValue(value);
}

function configureSheet(sheet, columns) {
  sheet.columns = columns.map(([key, header]) => ({ key, header, width: Math.min(55, Math.max(14, header.length + 2)) }));
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
  sheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
}

function addRows(sheet, columns, rows) {
  for (const row of rows) {
    const values = {};
    for (const [key] of columns) values[key] = valueForCell(row[key]);
    const excelRow = sheet.addRow(values);
    excelRow.alignment = { vertical: 'top', wrapText: true };
    for (const [key] of columns) {
      if (key.includes('url') || ['website','contact_page'].includes(key)) {
        const url = safeHyperlink(row[key]);
        if (url) excelRow.getCell(key).value = { text: url, hyperlink: url, tooltip: url };
      }
      if (key.includes('date') || key.includes('timestamp')) {
        const date = row[key] instanceof Date ? row[key] : new Date(row[key]);
        if (!Number.isNaN(date.getTime())) { excelRow.getCell(key).value = date; excelRow.getCell(key).numFmt = 'yyyy-mm-dd hh:mm'; }
      }
    }
  }
}

function addSummary(workbook, result, outputPath) {
  const sheet = workbook.addWorksheet('Sources & Run Summary');
  const rows = [
    ['Dataset', result.dataset], ['Requested Target', result.target], ['Qualified Count', result.qualified_count],
    ['Needs Manual Verification', result.manual_count], ['Duplicates Removed', result.duplicates], ['Rejected Records', result.rejected_count],
    ['Shortfall', Math.max(0, result.target - result.qualified_count)], ['Shortfall Reason', result.shortfall_reason || ''],
    ['Generated At', new Date()], ['Output Path', outputPath]
  ];
  sheet.columns = [{ width: 30 }, { width: 90 }];
  sheet.addRows(rows.map(([a,b]) => [sanitizeSpreadsheetValue(a), valueForCell(b)]));
  sheet.getColumn(2).alignment = { wrapText: true, vertical: 'top' };
  sheet.getRow(1).font = { bold: true };
}

async function atomicWrite(workbook, finalPath) {
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });
  const tempPath = `${finalPath}.${process.pid}.tmp`;
  await workbook.xlsx.writeFile(tempPath);
  fs.renameSync(tempPath, finalPath);
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(finalPath)).digest('hex');
  return { path: finalPath, sha256 };
}

async function exportUsWorkbook(result, outputDir = process.env.OUTPUT_DIRECTORY || 'exports') {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Zynqora Edge Data Collection';
  const groups = [
    ['High Priority Leads', result.leads.filter(l => l.priority === 'High' && l.verification_status === 'verified')],
    ['Medium Priority Leads', result.leads.filter(l => l.priority === 'Medium' && l.verification_status === 'verified')],
    ['Needs Manual Verification', result.leads.filter(l => l.verification_status !== 'verified')]
  ];
  for (const [name, leads] of groups) { const sheet = workbook.addWorksheet(name); configureSheet(sheet, US_COLUMNS); addRows(sheet, US_COLUMNS, leads); }
  const finalPath = path.resolve(outputDir, `US_Web_AI_Leads_${karachiDate()}.xlsx`);
  addSummary(workbook, result, finalPath);
  return atomicWrite(workbook, finalPath);
}

async function exportUkWorkbook(result, outputDir = process.env.OUTPUT_DIRECTORY || 'exports') {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Zynqora Edge Data Collection';
  const verified = result.leads.filter(l => l.verification_status === 'verified');
  const groups = [
    ['Verified Taxi Leads', verified.filter(l => l.business_type === 'taxi')],
    ['Verified Towing Leads', verified.filter(l => l.business_type === 'towing')],
    ['Needs Manual Verification', result.leads.filter(l => l.verification_status !== 'verified')]
  ];
  for (const [name, leads] of groups) { const sheet = workbook.addWorksheet(name); configureSheet(sheet, UK_COLUMNS); addRows(sheet, UK_COLUMNS, leads); }
  const finalPath = path.resolve(outputDir, `UK_Taxi_Towing_Leads_${karachiDate()}.xlsx`);
  addSummary(workbook, result, finalPath);
  return atomicWrite(workbook, finalPath);
}

module.exports = { exportUsWorkbook, exportUkWorkbook, karachiDate, US_COLUMNS, UK_COLUMNS };
