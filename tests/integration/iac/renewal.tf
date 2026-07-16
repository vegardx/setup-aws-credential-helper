terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "= 6.54.0"
    }
  }

  backend "s3" {}
}

variable "endpoint" {
  type = string
}

variable "bucket" {
  type = string
}

variable "marker_path" {
  type = string
}

variable "delay_seconds" {
  type = number
}

provider "aws" {
  region  = "us-east-1"
  profile = "deployment"

  endpoints {
    s3 = var.endpoint
  }

  s3_use_path_style           = true
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_region_validation      = true
  skip_requesting_account_id  = true
}

resource "aws_s3_object" "before_expiration" {
  bucket  = var.bucket
  key     = "renewal/before.txt"
  content = "before"
}

resource "terraform_data" "expiration_boundary" {
  depends_on = [aws_s3_object.before_expiration]

  provisioner "local-exec" {
    command = "printf ready > \"$MARKER_PATH\"; sleep \"$DELAY_SECONDS\""
    environment = {
      MARKER_PATH   = var.marker_path
      DELAY_SECONDS = tostring(var.delay_seconds)
    }
  }
}

resource "aws_s3_object" "after_expiration" {
  depends_on = [terraform_data.expiration_boundary]

  bucket  = var.bucket
  key     = "renewal/after.txt"
  content = "after"
}
