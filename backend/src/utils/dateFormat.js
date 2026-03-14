/**
 * Formatea una fecha para mostrar al usuario en estilo DD/MM/YY.
 * Acepta: YYYY-MM-DD (ISO/DB), DD/MM/YYYY, DD/MM/YY, o objeto Date.
 * @param {string|Date|null|undefined} val
 * @returns {string}
 */
function formatDateDDMMYY(val) {
  if (val == null) return '';
  if (val instanceof Date) {
    const d = val.getDate();
    const m = val.getMonth() + 1;
    const y = String(val.getFullYear()).slice(-2);
    return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;
  }
  const s = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [, y, m, d] = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return `${d}/${m}/${y.slice(-2)}`;
  }
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) {
    const parts = s.split('/');
    const d = parts[0].padStart(2, '0');
    const m = parts[1].padStart(2, '0');
    const y = parts[2].slice(-2);
    return `${d}/${m}/${y}`;
  }
  if (/^\d{1,2}\/\d{1,2}\/\d{2}$/.test(s)) return s;
  return s;
}

module.exports = { formatDateDDMMYY };
