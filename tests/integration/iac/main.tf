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

variable "prefix" {
  type = string
}

variable "content" {
  type    = string
  default = "initial"
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

resource "aws_s3_object" "workload" {
  bucket  = var.bucket
  key     = "${var.prefix}/workload.txt"
  content = var.content
}

output "workload_key" {
  value = aws_s3_object.workload.key
}
