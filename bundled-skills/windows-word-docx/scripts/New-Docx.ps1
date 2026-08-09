[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InputPath,

    [Parameter(Mandatory = $true)]
    [string]$OutputPath,

    [string]$Title = ""
)

$ErrorActionPreference = "Stop"

function Escape-XmlText {
    param([AllowEmptyString()][string]$Value)
    if ($null -eq $Value) { return "" }
    return [System.Security.SecurityElement]::Escape($Value)
}

function New-RunXml {
    param(
        [string]$Text,
        [switch]$Bold,
        [int]$Size = 22
    )

    $properties = '<w:sz w:val="{0}"/><w:szCs w:val="{0}"/>' -f $Size
    if ($Bold) { $properties = "<w:b/>$properties" }
    $escaped = Escape-XmlText $Text
    return '<w:r><w:rPr>{0}</w:rPr><w:t xml:space="preserve">{1}</w:t></w:r>' -f $properties, $escaped
}

function New-ParagraphXml {
    param(
        [string]$Text,
        [string]$Style = "Normal",
        [Nullable[int]]$NumberingId = $null
    )

    $paragraphProperties = '<w:pStyle w:val="{0}"/>' -f $Style
    if ($null -ne $NumberingId) {
        $paragraphProperties += '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="{0}"/></w:numPr>' -f $NumberingId
    }
    $bold = $Style -ne "Normal"
    $size = switch ($Style) {
        "Title" { 36 }
        "Heading1" { 30 }
        "Heading2" { 26 }
        "Heading3" { 24 }
        default { 22 }
    }
    $run = New-RunXml -Text $Text -Bold:$bold -Size $size
    return '<w:p><w:pPr>{0}</w:pPr>{1}</w:p>' -f $paragraphProperties, $run
}

if (-not (Test-Path -LiteralPath $InputPath -PathType Leaf)) {
    throw "Input file not found: $InputPath"
}

$resolvedInput = (Resolve-Path -LiteralPath $InputPath).Path
$resolvedOutput = [System.IO.Path]::GetFullPath($OutputPath)
if ([System.IO.Path]::GetExtension($resolvedOutput) -ne ".docx") {
    throw "OutputPath must end with .docx"
}

$outputDirectory = Split-Path -Parent $resolvedOutput
if (-not $outputDirectory) { $outputDirectory = (Get-Location).Path }
[System.IO.Directory]::CreateDirectory($outputDirectory) | Out-Null

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("pi-web-docx-" + [Guid]::NewGuid().ToString("N"))
$relsDirectory = Join-Path $tempRoot "_rels"
$wordDirectory = Join-Path $tempRoot "word"
$wordRelsDirectory = Join-Path $wordDirectory "_rels"
$propertiesDirectory = Join-Path $tempRoot "docProps"

try {
    [System.IO.Directory]::CreateDirectory($relsDirectory) | Out-Null
    [System.IO.Directory]::CreateDirectory($wordRelsDirectory) | Out-Null
    [System.IO.Directory]::CreateDirectory($propertiesDirectory) | Out-Null

    $paragraphs = [System.Collections.Generic.List[string]]::new()
    if ($Title.Trim()) {
        $paragraphs.Add((New-ParagraphXml -Text $Title.Trim() -Style "Title"))
    }

    foreach ($line in [System.IO.File]::ReadAllLines($resolvedInput, [System.Text.Encoding]::UTF8)) {
        $trimmed = $line.Trim()
        if (-not $trimmed) {
            $paragraphs.Add("<w:p/>")
        } elseif ($trimmed -match '^####\s+(.+)$') {
            $paragraphs.Add((New-ParagraphXml -Text $Matches[1] -Style "Heading3"))
        } elseif ($trimmed -match '^###\s+(.+)$') {
            $paragraphs.Add((New-ParagraphXml -Text $Matches[1] -Style "Heading2"))
        } elseif ($trimmed -match '^##\s+(.+)$') {
            $paragraphs.Add((New-ParagraphXml -Text $Matches[1] -Style "Heading1"))
        } elseif ($trimmed -match '^#\s+(.+)$') {
            $paragraphs.Add((New-ParagraphXml -Text $Matches[1] -Style "Title"))
        } elseif ($trimmed -match '^[-*]\s+(.+)$') {
            $paragraphs.Add((New-ParagraphXml -Text $Matches[1] -NumberingId 1))
        } elseif ($trimmed -match '^\d+[.)]\s+(.+)$') {
            $paragraphs.Add((New-ParagraphXml -Text $Matches[1] -NumberingId 2))
        } else {
            $paragraphs.Add((New-ParagraphXml -Text $trimmed))
        }
    }

    $documentXml = @"
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    $($paragraphs -join "`n    ")
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>
"@

    $stylesXml = @"
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Microsoft YaHei"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault></w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:spacing w:after="160" w:line="320" w:lineRule="auto"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:spacing w:after="360"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="320" w:after="160"/><w:outlineLvl w:val="0"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="260" w:after="140"/><w:outlineLvl w:val="1"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="220" w:after="120"/><w:outlineLvl w:val="2"/></w:pPr></w:style>
</w:styles>
"@

    $numberingXml = @"
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:tabs><w:tab w:val="num" w:pos="720"/></w:tabs><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>
  <w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:tabs><w:tab w:val="num" w:pos="720"/></w:tabs><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
  <w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>
"@

    $contentTypesXml = @"
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>
"@

    $rootRelationshipsXml = @"
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>
"@

    $documentRelationshipsXml = @"
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
</Relationships>
"@

    $timestamp = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
    $corePropertiesXml = @"
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>数字化AI助手</dc:creator><cp:lastModifiedBy>数字化AI助手</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">$timestamp</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">$timestamp</dcterms:modified></cp:coreProperties>
"@
    $appPropertiesXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>数字化AI助手</Application></Properties>'

    $utf8WithoutBom = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText((Join-Path $tempRoot "[Content_Types].xml"), $contentTypesXml, $utf8WithoutBom)
    [System.IO.File]::WriteAllText((Join-Path $relsDirectory ".rels"), $rootRelationshipsXml, $utf8WithoutBom)
    [System.IO.File]::WriteAllText((Join-Path $wordDirectory "document.xml"), $documentXml, $utf8WithoutBom)
    [System.IO.File]::WriteAllText((Join-Path $wordDirectory "styles.xml"), $stylesXml, $utf8WithoutBom)
    [System.IO.File]::WriteAllText((Join-Path $wordDirectory "numbering.xml"), $numberingXml, $utf8WithoutBom)
    [System.IO.File]::WriteAllText((Join-Path $wordRelsDirectory "document.xml.rels"), $documentRelationshipsXml, $utf8WithoutBom)
    [System.IO.File]::WriteAllText((Join-Path $propertiesDirectory "core.xml"), $corePropertiesXml, $utf8WithoutBom)
    [System.IO.File]::WriteAllText((Join-Path $propertiesDirectory "app.xml"), $appPropertiesXml, $utf8WithoutBom)

    foreach ($xmlPath in @(
        (Join-Path $tempRoot "[Content_Types].xml"),
        (Join-Path $wordDirectory "document.xml"),
        (Join-Path $wordDirectory "styles.xml"),
        (Join-Path $wordDirectory "numbering.xml")
    )) {
        $xmlDocument = [System.Xml.XmlDocument]::new()
        $xmlDocument.Load($xmlPath)
    }

    if (Test-Path -LiteralPath $resolvedOutput) {
        Remove-Item -LiteralPath $resolvedOutput -Force
    }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::CreateFromDirectory($tempRoot, $resolvedOutput)

    $archive = [System.IO.Compression.ZipFile]::OpenRead($resolvedOutput)
    try {
        $requiredEntries = @("[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/styles.xml", "word/numbering.xml")
        $entryNames = @($archive.Entries | ForEach-Object { $_.FullName.Replace("\", "/") })
        foreach ($requiredEntry in $requiredEntries) {
            if ($entryNames -notcontains $requiredEntry) {
                throw "Generated DOCX is missing required entry: $requiredEntry"
            }
        }
    } finally {
        $archive.Dispose()
    }

    Write-Output "Created DOCX: $resolvedOutput"
} finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}
