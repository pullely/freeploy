terraform {
  required_version = ">= 1.15.0"

  # State lives on the platform (SB1): the runner exports TF_HTTP_* per job, so
  # this block stays empty — no S3 bucket, no AWS role, no workspaces.
  backend "http" {}

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.52"
    }
  }
}

# --- Providers ---

# Authenticates via the CLOUDFLARE_API_TOKEN env var (provider-native): the
# token is an orun-managed secret resolved into the job env at run time, so it
# never transits Terraform variables.
provider "cloudflare" {}

# --- Variables (standard Orun parameters) ---

variable "cloudflare_account_id" {
  type        = string
  sensitive   = true
  default     = ""
  description = "Cloudflare account ID (from CLOUDFLARE_ACCOUNT_ID env var)"
}

variable "orgName" {
  type    = string
  default = "sourceplane"
}

variable "owner" {
  type    = string
  default = "sourceplane"
}

variable "repo" {
  type    = string
  default = "freeploy"
}

variable "namespace" {
  type    = string
  default = "sourceplane"
}

variable "namespacePrefix" {
  type    = string
  default = ""
}

variable "lane" {
  type    = string
  default = "verify"
}

variable "environment" {
  type    = string
  default = "stage"
}

variable "component" {
  type    = string
  default = "cloudflare-domain"
}

variable "stackName" {
  type    = string
  default = "cloudflare-domain"
}

variable "terraformDir" {
  type    = string
  default = "terraform"
}

variable "terraformVersion" {
  type    = string
  default = "1.15.3"
}

# --- Domain variables (from intent.yaml env and component parameters) ---

variable "baseDomain" {
  type        = string
  default     = "freeploy.io"
  description = "Root domain to manage (from BASE_DOMAIN env or component parameter)"
}

variable "zoneMode" {
  type        = string
  default     = "existing"
  description = "Zone management mode: 'existing' adopts zone, 'managed' creates it"
  validation {
    condition     = contains(["existing", "managed"], var.zoneMode)
    error_message = "zoneMode must be 'existing' or 'managed'."
  }
}

variable "workerNamePrefix" {
  type        = string
  default     = "freeploy-deploy-web"
  description = "Worker name prefix for the Freeploy console (deploy-web); full Worker service name is {prefix}-{environment}"
}

variable "CONSOLE_CUSTOM_DOMAIN" {
  type        = string
  default     = ""
  description = "Custom domain for the console (from CONSOLE_CUSTOM_DOMAIN env var via TF_VAR)"
}

# The API's custom hostname, attached to api-edge exactly as
# CONSOLE_CUSTOM_DOMAIN is attached to the console worker (the same shape as
# orun-cloud's cloudflare-domain). The console derives it from its own host
# (apps/deploy-web/src/lib/api.ts edgeBase(): app.<domain> -> api.<domain>,
# stage.<domain> -> api-stage.<domain>). Empty (the dev default) attaches
# nothing; the workers.dev hostname keeps serving alongside either way.
variable "API_CUSTOM_DOMAIN" {
  type        = string
  default     = ""
  description = "Custom domain for the API (api-edge), from API_CUSTOM_DOMAIN via TF_VAR. Empty = not attached."
}

variable "apiWorkerNamePrefix" {
  type        = string
  default     = "freeploy-api-edge"
  description = "Worker name prefix for api-edge; the environment is appended."
}

# --- Locals ---

locals {
  console_custom_domain = var.CONSOLE_CUSTOM_DOMAIN
  worker_name           = "${var.workerNamePrefix}-${var.environment}"
  has_custom_domain     = local.console_custom_domain != ""

  api_custom_domain     = var.API_CUSTOM_DOMAIN
  api_worker_name       = "${var.apiWorkerNamePrefix}-${var.environment}"
  has_api_custom_domain = local.api_custom_domain != ""
}

# --- Zone lookup (existing mode) ---

data "cloudflare_zone" "existing" {
  count = var.zoneMode == "existing" ? 1 : 0
  name  = var.baseDomain
}

# --- Zone creation (managed mode) ---

resource "cloudflare_zone" "managed" {
  count      = var.zoneMode == "managed" ? 1 : 0
  account_id = var.cloudflare_account_id
  zone       = var.baseDomain
  plan       = "free"
}

locals {
  zone_id     = var.zoneMode == "existing" ? data.cloudflare_zone.existing[0].id : cloudflare_zone.managed[0].id
  zone_name   = var.baseDomain
  zone_status = var.zoneMode == "existing" ? data.cloudflare_zone.existing[0].status : cloudflare_zone.managed[0].status
}

# --- Worker custom domain attachments ---
#
# The zone freeploy.io is delegated to Cloudflare and lives in the account
# the product deploys into (zoneMode existing). This stack's platform state
# has never held a custom-domain resource here — it was parked while the
# placeholder freeploy.dev had no zone — so, as orun-cloud did on its clean
# state, the v4 `cloudflare_workers_domain` resource is simply active under
# the ~> 4.52 pin (the old `removed {}` block for the template's v4->v5
# migration is gone with it). When the provider moves to v5, rename to
# `cloudflare_workers_custom_domain` with a state move.
#
# A Workers custom domain provisions its own DNS record and certificate, so
# nothing else in the zone has to know.

resource "cloudflare_workers_domain" "console" {
  count = local.has_custom_domain ? 1 : 0

  account_id  = var.cloudflare_account_id
  zone_id     = local.zone_id
  hostname    = local.console_custom_domain
  service     = local.worker_name
  environment = "production"
}

resource "cloudflare_workers_domain" "api" {
  count = local.has_api_custom_domain ? 1 : 0

  account_id  = var.cloudflare_account_id
  zone_id     = local.zone_id
  hostname    = local.api_custom_domain
  service     = local.api_worker_name
  environment = "production"
}

# --- Outputs (non-secret) ---

output "zone_id" {
  description = "Cloudflare zone ID"
  value       = local.zone_id
}

output "zone_name" {
  description = "Cloudflare zone name"
  value       = local.zone_name
}

output "zone_status" {
  description = "Cloudflare zone activation status"
  value       = local.zone_status
}

output "console_custom_domain" {
  description = "Console custom domain hostname"
  value       = local.console_custom_domain
}

output "worker_name" {
  description = "Worker service name bound to the custom domain"
  value       = local.worker_name
}

output "worker_custom_domain_id" {
  description = "ID of the console worker custom domain (if configured)"
  value       = local.has_custom_domain ? cloudflare_workers_domain.console[0].id : "not_configured"
}

output "api_custom_domain" {
  description = "API custom domain hostname"
  value       = local.api_custom_domain
}

output "api_worker_name" {
  description = "api-edge worker service name bound to the API custom domain"
  value       = local.api_worker_name
}

output "api_worker_custom_domain_id" {
  description = "ID of the api-edge worker custom domain (if configured)"
  value       = local.has_api_custom_domain ? cloudflare_workers_domain.api[0].id : "not_configured"
}
