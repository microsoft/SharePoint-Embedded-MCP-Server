@description('Name of the Static Web App')
param name string
param location string = resourceGroup().location
param tags object = {}

// Azure Static Web Apps is only available in a subset of regions, so a deploy
// `location` that is valid for the resource group (e.g. eastus) can still be
// rejected for the Static Web App with "Static Web Apps aren't available in
// <region>". Map an unsupported region to a supported nearby one so `azd up`
// succeeds regardless of the chosen deploy location (the RG itself can stay in
// the requested region). Keep this list aligned with the SWA availability docs:
// https://learn.microsoft.com/azure/static-web-apps/overview#regions
var swaSupportedRegions = [
  'centralus'
  'eastus2'
  'westus2'
  'westeurope'
  'eastasia'
]
var swaLocation = contains(swaSupportedRegions, toLower(location)) ? location : 'eastus2'

// azd matches this resource to the azure.yaml 'web' service via azd-service-name.
resource swa 'Microsoft.Web/staticSites@2023-12-01' = {
  name: name
  location: swaLocation
  tags: union(tags, { 'azd-service-name': 'web' })
  sku: { name: 'Free', tier: 'Free' }
  properties: {
    allowConfigFileUpdates: true
    provider: 'Custom'
    stagingEnvironmentPolicy: 'Enabled'
  }
}

output name string = swa.name
output uri string = 'https://${swa.properties.defaultHostname}'
