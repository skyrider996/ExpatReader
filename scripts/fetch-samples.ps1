$ErrorActionPreference = 'Stop'
$sampleDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\.cache\epub-samples'))
New-Item -ItemType Directory -Path $sampleDirectory -Force | Out-Null
$samples = @(
    @{ Name = 'moby-dick.epub'; Hash = '81BC079841A38E91A02A7776D04786A2FC311CFD300064E9FC533CE7C54CF7B4' },
    @{ Name = 'childrens-literature.epub'; Hash = '191D14D07BCAEFDE647E494256F73D789F265C8EDC46C404320641B23C86B76A' }
)
foreach ($sample in $samples) {
    $destination = Join-Path $sampleDirectory $sample.Name
    if (-not (Test-Path -LiteralPath $destination)) {
        Invoke-WebRequest -Uri ('https://github.com/IDPF/epub3-samples/releases/download/20230704/' + $sample.Name) -OutFile $destination
    }
    $actualHash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash
    if ($actualHash -ne $sample.Hash) { throw ('Unexpected SHA-256: ' + $sample.Name) }
    Write-Output ('Verified ' + $sample.Name + ' ' + $actualHash)
}
