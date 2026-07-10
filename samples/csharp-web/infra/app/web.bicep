extension 'br:mcr.microsoft.com/bicep/extensions/microsoftgraph/v1.0:0.1.8-preview'

@description('Name of the container app')
param name string
param location string = resourceGroup().location
param tags object = {}

param identityName string
param containerRegistryName string
param containerAppsEnvironmentName string
param exists bool
param resourceToken string
param deploymentTimestamp string

@description('SharePoint Embedded container type id to expose to the app')
param containerTypeId string = ''

@secure()
param appDefinition object

// Microsoft Graph delegated permissions the SPE app needs.
var graphAppId = '00000003-0000-0000-c000-000000000000'
var fileStorageContainerSelectedId = '085ca537-6565-41c2-aca7-db852babc212' // FileStorageContainer.Selected (delegated)
var userReadId = 'e1fe6dd8-ba31-4d61-89e7-88639da4683d' // User.Read (delegated)

var appSettingsArray = filter(array(appDefinition.settings), i => i.name != '')
var secrets = map(filter(appSettingsArray, i => i.?secret != null), i => {
  name: i.name
  value: i.value
  secretRef: i.?secretRef ?? take(replace(replace(toLower(i.name), '_', '-'), '.', '-'), 32)
})
var appEnv = map(filter(appSettingsArray, i => i.?secret == null), i => {
  name: i.name
  value: i.value
})

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: identityName
}

resource containerRegistry 'Microsoft.ContainerRegistry/registries@2023-01-01-preview' existing = {
  name: containerRegistryName
}

resource containerAppsEnvironment 'Microsoft.App/managedEnvironments@2023-05-01' existing = {
  name: containerAppsEnvironmentName
}

var appFqdn = '${name}.${containerAppsEnvironment.properties.defaultDomain}'

// Entra application that trusts the container app's managed identity via a
// federated credential — the app authenticates to Microsoft Graph / SPE with NO
// client secret (SignedAssertionFromManagedIdentity).
resource azureAdApp 'Microsoft.Graph/applications@v1.0' = {
  displayName: 'SharePoint Embedded App'
  uniqueName: 'spe-app-${resourceToken}-${uniqueString(resourceToken, deploymentTimestamp)}'
  web: {
    redirectUris: [
      'https://${appFqdn}/signin-oidc'
    ]
    logoutUrl: 'https://${appFqdn}/signout-oidc'
  }
  requiredResourceAccess: [
    {
      // Microsoft Graph
      resourceAppId: graphAppId
      resourceAccess: [
        {
          // FileStorageContainer.Selected (delegated) — SPE content access
          id: fileStorageContainerSelectedId
          type: 'Scope'
        }
        {
          // User.Read (delegated)
          id: userReadId
          type: 'Scope'
        }
      ]
    }
  ]

  resource managedIdentityFederatedCredential 'federatedIdentityCredentials@v1.0' = {
    name: '${azureAdApp.uniqueName}/managed-identity-federation'
    description: 'Trust the container app managed identity to impersonate the Entra application'
    audiences: [
      'api://AzureADTokenExchange'
    ]
    issuer: '${environment().authentication.loginEndpoint}${tenant().tenantId}/v2.0'
    subject: identity.properties.principalId
  }
}

// Least-privilege: grant ONLY AcrPull to the managed identity (no registry admin creds).
resource acrPullRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: containerRegistry
  name: guid(subscription().id, resourceGroup().id, identity.id, 'acrPullRole')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
    principalType: 'ServicePrincipal'
    principalId: identity.properties.principalId
  }
}

module fetchLatestImage '../modules/fetch-container-image.bicep' = {
  name: '${name}-fetch-image'
  params: {
    exists: exists
    name: name
  }
}

resource app 'Microsoft.App/containerApps@2023-05-02-preview' = {
  name: name
  location: location
  tags: union(tags, { 'azd-service-name': 'web' })
  dependsOn: [
    acrPullRole
  ]
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: containerAppsEnvironment.id
    configuration: {
      ingress: {
        external: true
        targetPort: 8080
        transport: 'auto'
      }
      registries: [
        {
          server: '${containerRegistryName}.azurecr.io'
          identity: identity.id
        }
      ]
      secrets: union([], map(secrets, secret => {
        name: secret.secretRef
        value: secret.value
      }))
    }
    template: {
      containers: [
        {
          image: fetchLatestImage.outputs.?containers[?0].?image ?? 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest'
          name: 'main'
          env: union([
            {
              name: 'PORT'
              value: '8080'
            }
            {
              name: 'AzureAd__Instance'
              value: environment().authentication.loginEndpoint
            }
            {
              name: 'AzureAd__TenantId'
              value: tenant().tenantId
            }
            {
              name: 'AzureAd__ClientId'
              value: azureAdApp.appId
            }
            {
              name: 'AzureAd__CallbackPath'
              value: '/signin-oidc'
            }
            {
              name: 'AzureAd__SignedOutCallbackPath'
              value: '/signout-callback-oidc'
            }
            {
              name: 'AzureAd__ClientCredentials__0__SourceType'
              value: 'SignedAssertionFromManagedIdentity'
            }
            {
              name: 'AzureAd__ClientCredentials__0__ManagedIdentityClientId'
              value: identity.properties.clientId
            }
            {
              name: 'AzureAd__ClientCredentials__0__TokenExchangeUrl'
              value: 'api://AzureADTokenExchange/.default'
            }
            {
              name: 'SharePointEmbedded__TenantId'
              value: tenant().tenantId
            }
            {
              name: 'SharePointEmbedded__ClientId'
              value: azureAdApp.appId
            }
            {
              name: 'SharePointEmbedded__ContainerTypeId'
              value: containerTypeId
            }
          ], appEnv, map(secrets, secret => {
            name: secret.name
            secretRef: secret.secretRef
          }))
          resources: {
            cpu: json('0.5')
            memory: '1.0Gi'
          }
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 10
      }
    }
  }
}

output name string = app.name
output uri string = 'https://${app.properties.configuration.ingress.fqdn}'
output id string = app.id
output appId string = azureAdApp.appId
output appUniqueName string = azureAdApp.uniqueName
output defaultDomain string = containerAppsEnvironment.properties.defaultDomain
