# ==========================================================================
# Osekkai Hamamatsu Web & REST API Server (PowerShell Native)
# Persistent db.json Storage & Multi-Device LAN Mobile Sync
# ==========================================================================

$scriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -Path $scriptPath

$dbPath = Join-Path $scriptPath "db.json"

function Load-DB {
    if (Test-Path $dbPath) {
        try {
            $raw = [System.IO.File]::ReadAllText($dbPath, [System.Text.Encoding]::UTF8)
            return $raw | ConvertFrom-Json
        } catch {}
    }
    return [PSCustomObject]@{
        tasks = @()
        npoStats = [PSCustomObject]@{ totalMealsServed = 0; totalDonationYen = 0; supportedCafeterias = 0; registeredSupporters = 0 }
        chatStore = [PSCustomObject]@{}
        autoReplies = @("Arigatou gozaimasu!")
        userVerifications = [PSCustomObject]@{ defaultUser = [PSCustomObject]@{ requester = $true; helper = $true } }
    }
}

function Save-DB($dbData) {
    try {
        $json = $dbData | ConvertTo-Json -Depth 10
        [System.IO.File]::WriteAllText($dbPath, $json, [System.Text.Encoding]::UTF8)
    } catch {
        Write-Host "Error saving db.json: $_" -ForegroundColor Red
    }
}

$localIps = Get-NetIPAddress -AddressFamily IPv4 -Type Unicast -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } | Select-Object -ExpandProperty IPAddress

$listener = New-Object System.Net.HttpListener

$wildcardStarted = $false
try {
    $listener.Prefixes.Add("http://+:3000/")
    $listener.Start()
    $wildcardStarted = $true
} catch {
    $listener = New-Object System.Net.HttpListener
    $listener.Prefixes.Add("http://localhost:3000/")
    $listener.Start()
}

Clear-Host
Write-Host "============================================================" -ForegroundColor Green
Write-Host " Osekkai Hamamatsu Server Running!" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Green
Write-Host " PC Access:             http://localhost:8080/" -ForegroundColor Yellow
if ($localIps) {
    foreach ($ip in $localIps) {
        Write-Host " Mobile Access (Wi-Fi): http://${ip}:8080/" -ForegroundColor Yellow
    }
} else {
    Write-Host " Mobile Access (Wi-Fi): http://192.168.X.X:8080/" -ForegroundColor Yellow
}
Write-Host "============================================================" -ForegroundColor Green
Write-Host "Press Ctrl + C to stop the server.`n" -ForegroundColor Gray

while ($listener.IsListening) {
    try {
        $context = $listener.GetContext()
        $request = $context.Request
        $response = $context.Response

        $response.Headers.Add("Access-Control-Allow-Origin", "*")
        $response.Headers.Add("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        $response.Headers.Add("Access-Control-Allow-Headers", "Content-Type")
        $response.Headers.Add("Cache-Control", "no-cache, no-store, must-revalidate")
        $response.Headers.Add("Pragma", "no-cache")
        $response.Headers.Add("Expires", "0")

        if ($request.HttpMethod -eq "OPTIONS") {
            $response.StatusCode = 204
            $response.Close()
            continue
        }

        $urlPath = $request.Url.LocalPath
        $httpMethod = $request.HttpMethod

        function Read-PostBody($req) {
            if ($req.HasEntityBody -and $req.ContentLength64 -gt 0) {
                $len = [int]$req.ContentLength64
                $buffer = New-Object byte[] $len
                $readTotal = 0
                while ($readTotal -lt $len) {
                    $r = $req.InputStream.Read($buffer, $readTotal, $len - $readTotal)
                    if ($r -le 0) { break }
                    $readTotal += $r
                }
                $str = [System.Text.Encoding]::UTF8.GetString($buffer, 0, $readTotal)
                return $str | ConvertFrom-Json
            }
            return $null
        }

        if ($urlPath -eq "/api/reset" -and $httpMethod -eq "POST") {
            $db = [PSCustomObject]@{
                tasks = @()
                npoStats = [PSCustomObject]@{ totalMealsServed = 0; totalDonationYen = 0; supportedCafeterias = 0; registeredSupporters = 0 }
                chatStore = [PSCustomObject]@{}
                autoReplies = @("Arigatou gozaimasu!")
                userVerifications = [PSCustomObject]@{ defaultUser = [PSCustomObject]@{ requester = $true; helper = $true } }
            }
            Save-DB $db
            $resObj = [PSCustomObject]@{ success = $true; npoStats = $db.npoStats }
            $bytes = [System.Text.Encoding]::UTF8.GetBytes(($resObj | ConvertTo-Json -Depth 5))
            $response.ContentType = "application/json; charset=utf-8"
            $response.ContentLength64 = $bytes.Length
            $response.OutputStream.Write($bytes, 0, $bytes.Length)
            $response.Close()
            continue
        }

        if ($urlPath -eq "/api/stats" -and $httpMethod -eq "GET") {
            $db = Load-DB
            $json = $db.npoStats | ConvertTo-Json -Depth 5
            $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
            $response.ContentType = "application/json; charset=utf-8"
            $response.ContentLength64 = $bytes.Length
            $response.OutputStream.Write($bytes, 0, $bytes.Length)
            $response.Close()
            continue
        }

        if ($urlPath -eq "/api/tasks" -and $httpMethod -eq "GET") {
            $db = Load-DB
            $tasks = $db.tasks | Where-Object { $_.status -eq "open" }
            if ($null -eq $tasks) { $tasks = @() }
            $json = $tasks | ConvertTo-Json -Depth 5
            if (-not $json) { $json = "[]" }
            $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
            $response.ContentType = "application/json; charset=utf-8"
            $response.ContentLength64 = $bytes.Length
            $response.OutputStream.Write($bytes, 0, $bytes.Length)
            $response.Close()
            continue
        }

        if ($urlPath -eq "/api/tasks" -and $httpMethod -eq "POST") {
            $postObj = Read-PostBody $request
            $db = Load-DB

            $areaBase = "Hamamatsu"
            if ($postObj -and $postObj.area) { $areaBase = [string]$postObj.area }

            $titleVal = "New Request"
            if ($postObj -and $postObj.title) { $titleVal = [string]$postObj.title }

            $descVal = ""
            if ($postObj -and $postObj.description) { $descVal = [string]$postObj.description }

            $catVal = "housework"
            if ($postObj -and $postObj.category) { $catVal = [string]$postObj.category }

            $catNameVal = "Housework"
            if ($postObj -and $postObj.categoryName) { $catNameVal = [string]$postObj.categoryName }

            $fuzzyStr = $areaBase + " (500m area)"
            $exactStr = $areaBase + " Registered Address"

            $newTask = [PSCustomObject]@{
                id = "task-" + [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
                category = $catVal
                categoryName = $catNameVal
                title = $titleVal
                description = $descVal
                fuzzyLocation = $fuzzyStr
                exactLocation = $exactStr
                requesterName = "User (Verified)"
                requesterVerified = $true
                timeAgo = "Just now"
                status = "open"
                donationAmount = 500
            }

            $currentTasks = [System.Collections.ArrayList]@($db.tasks)
            $currentTasks.Insert(0, $newTask)
            $db.tasks = $currentTasks

            Save-DB $db

            $resObj = [PSCustomObject]@{ success = $true; task = $newTask }
            $bytes = [System.Text.Encoding]::UTF8.GetBytes(($resObj | ConvertTo-Json -Depth 5))
            $response.StatusCode = 201
            $response.ContentType = "application/json; charset=utf-8"
            $response.ContentLength64 = $bytes.Length
            $response.OutputStream.Write($bytes, 0, $bytes.Length)
            $response.Close()
            continue
        }

        if ($urlPath -like "/api/tasks/*/complete" -and $httpMethod -eq "POST") {
            $taskId = $urlPath.Split('/')[3]
            $db = Load-DB

            $db.tasks = @($db.tasks | Where-Object { $_.id -ne $taskId })
            $db.npoStats.totalMealsServed = [int]$db.npoStats.totalMealsServed + 1
            $db.npoStats.totalDonationYen = [int]$db.npoStats.totalDonationYen + 500

            Save-DB $db

            $resObj = [PSCustomObject]@{ success = $true; npoStats = $db.npoStats }
            $bytes = [System.Text.Encoding]::UTF8.GetBytes(($resObj | ConvertTo-Json -Depth 5))
            $response.ContentType = "application/json; charset=utf-8"
            $response.ContentLength64 = $bytes.Length
            $response.OutputStream.Write($bytes, 0, $bytes.Length)
            $response.Close()
            continue
        }

        if ($urlPath -like "/api/chat/*" -and $httpMethod -eq "GET") {
            $taskId = $urlPath.Split('/')[3]
            $db = Load-DB
            $history = if ($db.chatStore."$taskId") { $db.chatStore."$taskId" } else { @() }
            $json = $history | ConvertTo-Json -Depth 5
            if (-not $json) { $json = "[]" }
            $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
            $response.ContentType = "application/json; charset=utf-8"
            $response.ContentLength64 = $bytes.Length
            $response.OutputStream.Write($bytes, 0, $bytes.Length)
            $response.Close()
            continue
        }

        if ($urlPath -like "/api/chat/*" -and $httpMethod -eq "POST") {
            $taskId = $urlPath.Split('/')[3]
            $postObj = Read-PostBody $request
            $db = Load-DB

            if (-not $db.chatStore) { $db.chatStore = [PSCustomObject]@{} }
            $existing = if ($db.chatStore."$taskId") { [System.Collections.ArrayList]@($db.chatStore."$taskId") } else { [System.Collections.ArrayList]@() }

            $timeStr = (Get-Date).ToString("HH:mm")
            $senderVal = "me"
            if ($postObj -and $postObj.sender) { $senderVal = [string]$postObj.sender }
            $textVal = ""
            if ($postObj -and $postObj.text) { $textVal = [string]$postObj.text }

            $userMsg = [PSCustomObject]@{
                sender = $senderVal
                text = $textVal
                time = $timeStr
            }
            $existing.Add($userMsg) | Out-Null

            if ($senderVal -ne "them") {
                $replies = $db.autoReplies
                if ($null -eq $replies -or $replies.Count -eq 0) {
                    $replies = @("Thank you for contacting!")
                }
                $randomReply = $replies[(Get-Random -Maximum $replies.Count)]
                $autoMsg = [PSCustomObject]@{
                    sender = "them"
                    text = $randomReply
                    time = $timeStr
                }
                $existing.Add($autoMsg) | Out-Null
            }

            $db.chatStore | Add-Member -NotePropertyName $taskId -NotePropertyValue $existing -Force
            Save-DB $db

            $resObj = [PSCustomObject]@{ success = $true; message = $userMsg }
            $bytes = [System.Text.Encoding]::UTF8.GetBytes(($resObj | ConvertTo-Json -Depth 5))
            $response.ContentType = "application/json; charset=utf-8"
            $response.ContentLength64 = $bytes.Length
            $response.OutputStream.Write($bytes, 0, $bytes.Length)
            $response.Close()
            continue
        }

        if ($urlPath -eq "/api/user/verify") {
            $db = Load-DB
            $json = $db.userVerifications | ConvertTo-Json -Depth 5
            $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
            $response.ContentType = "application/json; charset=utf-8"
            $response.ContentLength64 = $bytes.Length
            $response.OutputStream.Write($bytes, 0, $bytes.Length)
            $response.Close()
            continue
        }

        # --- Static File Serving ---
        if ($urlPath -eq "/") { $urlPath = "/index.html" }
        $filePath = [System.IO.Path]::Combine($scriptPath, $urlPath.TrimStart('/'))

        if ([System.IO.File]::Exists($filePath)) {
            $bytes = [System.IO.File]::ReadAllBytes($filePath)
            $ext = [System.IO.Path]::GetExtension($filePath).ToLower()
            switch ($ext) {
                ".html" { $response.ContentType = "text/html; charset=utf-8" }
                ".css"  { $response.ContentType = "text/css; charset=utf-8" }
                ".js"   { $response.ContentType = "application/javascript; charset=utf-8" }
                ".png"  { $response.ContentType = "image/png" }
                ".json" { $response.ContentType = "application/json; charset=utf-8" }
                default { $response.ContentType = "text/plain; charset=utf-8" }
            }
            $response.ContentLength64 = $bytes.Length
            $response.OutputStream.Write($bytes, 0, $bytes.Length)
        } else {
            $response.StatusCode = 404
            $buffer = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found")
            $response.OutputStream.Write($buffer, 0, $buffer.Length)
        }
        $response.Close()
    } catch {
        # Continue loop on request error
    }
}
