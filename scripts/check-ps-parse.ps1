param([Parameter(Mandatory=$true)][string]$Path)
$tokens = $null
$errors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $Path), [ref]$tokens, [ref]$errors)
if ($errors -and $errors.Count -gt 0) {
	$errors | ForEach-Object { $_.ToString() }
	exit 1
}
Write-Output "PARSE-OK"
exit 0
