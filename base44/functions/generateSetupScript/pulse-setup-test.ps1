#Requires -Version 5.1
# PULSE -- Clore Fleet mass-onboarding API test
# Paste the base64 token from clore.ai/my-servers -> Mass Onboard into $CLOREAI_FLEET_TOKEN.
# No WSL, no GPU needed.

$CLOREAI_FLEET_TOKEN = ""

# Fixed test machine name -- re-runs update the same slot instead of creating a new one.
# DELETE this server from clore.ai/my-servers after testing.
$MACHINE_NAME = "PULSE_TEST_ONBOARD"

Write-Host ""
Write-Host "  PULSE -- Clore Fleet onboarding test" -ForegroundColor Cyan
Write-Host ""

# --- Decode the base64 fleet config ---
try {
    $padding = 4 - ($CLOREAI_FLEET_TOKEN.Length % 4)
    if ($padding -ne 4) { $padded = $CLOREAI_FLEET_TOKEN + ("=" * $padding) } else { $padded = $CLOREAI_FLEET_TOKEN }
    $decoded  = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($padded))
    $fleetCfg = $decoded | ConvertFrom-Json
} catch {
    Write-Host "  [X]  Could not decode fleet token -- make sure you pasted the base64 blob from Mass Onboard." -ForegroundColor Red
    Write-Host ""
    Read-Host "  Press Enter to exit"
    exit 1
}

$AUTH_TOKEN = $fleetCfg.auth
$MRL        = $fleetCfg.mrl

Write-Host "  Decoded config:" -ForegroundColor DarkGray
Write-Host "    auth:                    $AUTH_TOKEN" -ForegroundColor DarkGray
Write-Host "    mrl:                     $MRL hours" -ForegroundColor DarkGray
Write-Host "    on_demand_bitcoin:       $($fleetCfg.on_demand_bitcoin)" -ForegroundColor DarkGray
Write-Host "    on_demand_clore:         $($fleetCfg.on_demand_clore)" -ForegroundColor DarkGray
Write-Host "    on_demand_usd_blockchain:$($fleetCfg.on_demand_usd_blockchain)" -ForegroundColor DarkGray
Write-Host "  Machine: $MACHINE_NAME" -ForegroundColor DarkGray
Write-Host ""

# --- Build request body from decoded config (auth goes in header only, not body) ---
$bodyObj = @{ name = $MACHINE_NAME; mrl = $MRL; specs = @{
    mb         = "ASUS ROG STRIX Z690-E"
    cpu        = "Intel Core i9-12900K"
    cpus       = "16/24"
    ram        = 64.0
    disk       = "SSD 500.0GB"
    disk_speed = 500.0
    gpu        = "1x NVIDIA GeForce RTX 3080"
    gpuram     = 10.24
    net        = @{ cc = "US"; down = 500.0; up = 100.0 }
}}

# Carry across any pricing fields from the decoded config
foreach ($key in @("on_demand_bitcoin","on_demand_clore","spot_bitcoin","spot_clore","on_demand_usd_blockchain","spot_usd_blockchain","keep_params")) {
    if ($null -ne $fleetCfg.$key) { $bodyObj[$key] = $fleetCfg.$key }
}

$body = $bodyObj | ConvertTo-Json -Depth 4

Write-Host "  [1/2] Calling machine_onboarding..." -ForegroundColor Cyan
Write-Host "  Body: $body" -ForegroundColor DarkGray
Write-Host ""

try {
    $resp = Invoke-RestMethod `
        -Method POST `
        -Uri "https://api.clore.ai/machine_onboarding" `
        -ContentType "application/json" `
        -Headers @{ "auth" = $AUTH_TOKEN } `
        -Body $body

    Write-Host "  Response:" -ForegroundColor White
    Write-Host "  $($resp | ConvertTo-Json -Depth 5)" -ForegroundColor Green
    Write-Host ""

    if ($resp.init_communication_token -and $resp.private_communication_token) {
        Write-Host "  [OK] Server registered successfully!" -ForegroundColor Green
        Write-Host "       init_communication_token:    $($resp.init_communication_token)" -ForegroundColor Green
        Write-Host "       private_communication_token: $($resp.private_communication_token)" -ForegroundColor Green
        Write-Host ""
        Write-Host "  NOTE: Test server '$MACHINE_NAME' was created on your Clore account." -ForegroundColor Yellow
        Write-Host "        Delete it from clore.ai/my-servers after testing." -ForegroundColor Yellow
    } elseif ($resp.status -eq "creation_pending") {
        Write-Host "  [..] Creation pending -- Clore is provisioning the server slot." -ForegroundColor Cyan
        Write-Host "       Fleet auth is valid. Re-run in ~10 seconds to get auth tokens." -ForegroundColor Cyan
    } elseif ($resp.status -eq "invalid_auth") {
        Write-Host "  [X]  Fleet auth token rejected. Regenerate from clore.ai Mass Onboard." -ForegroundColor Red
    } elseif ($resp.status -eq "exceeded_limit") {
        Write-Host "  [!!] Account is at the maximum server limit." -ForegroundColor Yellow
        Write-Host "       Remove unused servers from clore.ai/my-servers, then retry." -ForegroundColor Yellow
    } elseif ($resp.error -eq "exceeded_rate_limit") {
        Write-Host "  [!!] Rate limited -- wait 65 seconds and retry." -ForegroundColor Yellow
    } else {
        Write-Host "  [!!] Unexpected response -- see above." -ForegroundColor Yellow
    }
} catch {
    Write-Host ""
    Write-Host "  [X]  Request failed: $_" -ForegroundColor Red
    Write-Host "  Status: $($_.Exception.Response.StatusCode)" -ForegroundColor Red
}

Write-Host ""
Read-Host "  Press Enter to exit"
