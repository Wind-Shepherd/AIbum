"""Small read-only XLSX export; all text stays literal, never an Excel formula."""
from io import BytesIO
from xml.sax.saxutils import escape
import re
import zipfile


def workbook(sheets):
    def safe(value):
        return escape(re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', '', str(value)))
    ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
    rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
    output = BytesIO()
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('_rels/.rels', f'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="{rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>')
        entries=[]; relationships=[]; types=[]
        for number, (name, rows) in enumerate(sheets, 1):
            entries.append(f'<sheet name="{safe(name)}" sheetId="{number}" r:id="rId{number}"/>')
            relationships.append(f'<Relationship Id="rId{number}" Type="{rel}/worksheet" Target="worksheets/sheet{number}.xml"/>')
            types.append(f'<Override PartName="/xl/worksheets/sheet{number}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>')
            xml=[]
            for row in rows:
                cells=[]
                for value in row:
                    if type(value) in (int, float): cells.append(f'<c><v>{value}</v></c>')
                    else: cells.append(f'<c t="inlineStr"><is><t xml:space="preserve">{safe(value if value is not None else "")}</t></is></c>')
                xml.append('<row>'+''.join(cells)+'</row>')
            archive.writestr(f'xl/worksheets/sheet{number}.xml',f'<worksheet xmlns="{ns}"><sheetData>'+''.join(xml)+'</sheetData></worksheet>')
        archive.writestr('xl/workbook.xml',f'<workbook xmlns="{ns}" xmlns:r="{rel}"><sheets>'+''.join(entries)+'</sheets></workbook>')
        archive.writestr('xl/_rels/workbook.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+''.join(relationships)+'</Relationships>')
        archive.writestr('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'+''.join(types)+'</Types>')
    return output.getvalue()
