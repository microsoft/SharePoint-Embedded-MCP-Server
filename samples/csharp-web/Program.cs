// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// Minimal SharePoint Embedded reference app (ASP.NET Core, top-level statements).
// SPE settings arrive as environment variables injected by the Container App
// (see infra/app/web.bicep) or from appsettings.Development.json when run locally.
var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

var cfg = app.Configuration;

app.MapGet("/", () => Results.Json(new
{
    status = "ok",
    message = "SharePoint Embedded reference app is running.",
    tenantId = cfg["SharePointEmbedded:TenantId"],
    clientId = cfg["SharePointEmbedded:ClientId"],
    containerTypeId = cfg["SharePointEmbedded:ContainerTypeId"]
}));

app.MapGet("/healthz", () => Results.Ok("healthy"));

app.Run();
