/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!50503 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;

--
-- Table structure for table `approvals_approval_requests`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `approvals_approval_requests` (
  `id` binary(16) NOT NULL,
  `operation_type` varchar(30) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `subject_type` varchar(40) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `subject_id` binary(16) NOT NULL,
  `subject_summary` text COLLATE utf8mb4_0900_as_cs NOT NULL,
  `site_id` binary(16) DEFAULT NULL,
  `zone_id` binary(16) DEFAULT NULL,
  `amount_xaf` bigint DEFAULT NULL,
  `requested_by` binary(16) NOT NULL,
  `requested_at` datetime(6) NOT NULL,
  `policy_id` binary(16) DEFAULT NULL,
  `policy_version` int DEFAULT NULL,
  `required_attachment_ids` json NOT NULL DEFAULT (json_array()),
  `status` varchar(20) COLLATE utf8mb4_0900_as_cs NOT NULL DEFAULT 'PENDING',
  `decision_option` varchar(40) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `decided_by` binary(16) DEFAULT NULL,
  `decided_at` datetime(6) DEFAULT NULL,
  `decision_comment` text COLLATE utf8mb4_0900_as_cs,
  `self_approved` tinyint(1) NOT NULL DEFAULT '0',
  `escalated_at` datetime(6) DEFAULT NULL,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `updated_by` binary(16) DEFAULT NULL,
  `version` int NOT NULL DEFAULT '1',
  `active_pending_key` varchar(150) COLLATE utf8mb4_0900_as_cs GENERATED ALWAYS AS (if((`status` = _utf8mb4'PENDING'),concat(`subject_type`,_utf8mb4':',hex(`subject_id`),_utf8mb4':',`operation_type`),NULL)) STORED,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_approvals_approval_requests_active_pending` (`active_pending_key`),
  KEY `ix_approvals_approval_requests_status_site` (`status`,`site_id`),
  KEY `ix_approvals_approval_requests_status_operation` (`status`,`operation_type`),
  KEY `ix_approvals_approval_requests_requested_by` (`requested_by`),
  KEY `fk_approvals_approval_requests_site` (`site_id`),
  KEY `fk_approvals_approval_requests_zone` (`zone_id`),
  KEY `fk_approvals_approval_requests_policy` (`policy_id`),
  KEY `fk_approvals_approval_requests_decided_by` (`decided_by`),
  KEY `fk_approvals_approval_requests_created_by` (`created_by`),
  KEY `fk_approvals_approval_requests_updated_by` (`updated_by`),
  CONSTRAINT `fk_approvals_approval_requests_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_approvals_approval_requests_decided_by` FOREIGN KEY (`decided_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_approvals_approval_requests_policy` FOREIGN KEY (`policy_id`) REFERENCES `approvals_control_policies` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_approvals_approval_requests_requested_by` FOREIGN KEY (`requested_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_approvals_approval_requests_site` FOREIGN KEY (`site_id`) REFERENCES `organization_sites` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_approvals_approval_requests_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_approvals_approval_requests_zone` FOREIGN KEY (`zone_id`) REFERENCES `organization_zones` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_approvals_approval_requests_amount` CHECK (((`amount_xaf` is null) or (`amount_xaf` >= 0))),
  CONSTRAINT `ck_approvals_approval_requests_decision` CHECK ((((`status` in (_utf8mb4'APPROVED',_utf8mb4'REJECTED')) and (`decided_by` is not null) and (`decided_at` is not null)) or ((`status` not in (_utf8mb4'APPROVED',_utf8mb4'REJECTED')) and (`decided_by` is null) and (`decided_at` is null)))),
  CONSTRAINT `ck_approvals_approval_requests_self_approval` CHECK (((`decided_by` is null) or (`decided_by` <> `requested_by`) or (`self_approved` = true))),
  CONSTRAINT `ck_approvals_approval_requests_status` CHECK ((`status` in (_utf8mb4'PENDING',_utf8mb4'APPROVED',_utf8mb4'REJECTED',_utf8mb4'CANCELLED')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_approvals_approval_requests_update_guard` BEFORE UPDATE ON `approvals_approval_requests` FOR EACH ROW BEGIN
  IF OLD.status IN ('APPROVED', 'REJECTED', 'CANCELLED') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'approvals_approval_requests : immuable après décision.';
  END IF;
  IF NOT (
    NEW.operation_type <=> OLD.operation_type AND
    NEW.subject_type <=> OLD.subject_type AND
    NEW.subject_id <=> OLD.subject_id AND
    NEW.subject_summary <=> OLD.subject_summary AND
    NEW.site_id <=> OLD.site_id AND
    NEW.zone_id <=> OLD.zone_id AND
    NEW.amount_xaf <=> OLD.amount_xaf AND
    NEW.requested_by <=> OLD.requested_by AND
    NEW.requested_at <=> OLD.requested_at AND
    NEW.policy_id <=> OLD.policy_id AND
    NEW.policy_version <=> OLD.policy_version AND
    NEW.required_attachment_ids <=> OLD.required_attachment_ids AND
    NEW.created_at <=> OLD.created_at AND
    NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'approvals_approval_requests : seule la décision (et son escalade) est modifiable avant clôture.';
  END IF;
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_approvals_approval_requests_no_delete` BEFORE DELETE ON `approvals_approval_requests` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'approvals_approval_requests : suppression physique interdite (INV-GLO-03) ; utiliser CANCELLED.';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `approvals_control_policies`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `approvals_control_policies` (
  `id` binary(16) NOT NULL,
  `code` varchar(40) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `version` int NOT NULL DEFAULT '1',
  `operation_type` varchar(30) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `condition` json NOT NULL DEFAULT (json_object()),
  `requires_photo` tinyint(1) NOT NULL DEFAULT '0',
  `requires_comment` tinyint(1) NOT NULL DEFAULT '0',
  `requires_approval` tinyint(1) NOT NULL DEFAULT '0',
  `approver_permission` varchar(80) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `approver_scope` varchar(10) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `valid_from` datetime(6) NOT NULL,
  `valid_to` datetime(6) DEFAULT NULL,
  `status` varchar(20) COLLATE utf8mb4_0900_as_cs NOT NULL DEFAULT 'ACTIVE',
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_approvals_control_policies_code_version` (`code`,`version`),
  KEY `fk_approvals_control_policies_permission` (`approver_permission`),
  KEY `fk_approvals_control_policies_created_by` (`created_by`),
  CONSTRAINT `fk_approvals_control_policies_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_approvals_control_policies_permission` FOREIGN KEY (`approver_permission`) REFERENCES `identity_permissions` (`code`) ON DELETE RESTRICT,
  CONSTRAINT `ck_approvals_control_policies_approver_scope` CHECK (((`approver_scope` is null) or (`approver_scope` in (_utf8mb4'SITE',_utf8mb4'ZONE',_utf8mb4'TEAM',_utf8mb4'ALL')))),
  CONSTRAINT `ck_approvals_control_policies_operation_type` CHECK ((`operation_type` in (_utf8mb4'LOSS_DECLARATION',_utf8mb4'MORTALITY',_utf8mb4'INVENTORY_ADJUSTMENT',_utf8mb4'TRANSFER_DISCREPANCY',_utf8mb4'EXPENSE',_utf8mb4'PURCHASE_REQUEST',_utf8mb4'PURCHASE_ORDER',_utf8mb4'RECEIPT_WITHOUT_PO',_utf8mb4'RECEIPT_VALUE',_utf8mb4'SUPPLIER_PAYMENT',_utf8mb4'PRICE_OVERRIDE',_utf8mb4'SALE_CANCELLATION',_utf8mb4'CREDIT_LIMIT_EXCEEDED',_utf8mb4'CASH_VARIANCE',_utf8mb4'CHECKIN_OVERRIDE',_utf8mb4'RECEIPT_QUARANTINE',_utf8mb4'RECEIPT_CANCELLATION',_utf8mb4'ANIMAL_COUNT_ADJUSTMENT',_utf8mb4'PAYMENT_CANCELLATION',_utf8mb4'PAYMENT_DUPLICATE'))),
  CONSTRAINT `ck_approvals_control_policies_requires_approval` CHECK (((`requires_approval` = false) or (`approver_permission` is not null))),
  CONSTRAINT `ck_approvals_control_policies_status` CHECK ((`status` in (_utf8mb4'ACTIVE',_utf8mb4'RETIRED')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_approvals_control_policies_update_guard` BEFORE UPDATE ON `approvals_control_policies` FOR EACH ROW BEGIN
  IF NOT (
    NEW.code <=> OLD.code AND
    NEW.version <=> OLD.version AND
    NEW.operation_type <=> OLD.operation_type AND
    NEW.`condition` <=> OLD.`condition` AND
    NEW.requires_photo <=> OLD.requires_photo AND
    NEW.requires_comment <=> OLD.requires_comment AND
    NEW.requires_approval <=> OLD.requires_approval AND
    NEW.approver_permission <=> OLD.approver_permission AND
    NEW.approver_scope <=> OLD.approver_scope AND
    NEW.valid_from <=> OLD.valid_from AND
    NEW.created_at <=> OLD.created_at AND
    NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'approvals_control_policies : seuls status et valid_to sont modifiables (versionnement, BR-ADM-016).';
  END IF;
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_approvals_control_policies_no_delete` BEFORE DELETE ON `approvals_control_policies` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'approvals_control_policies : suppression physique interdite (versionnement, BR-ADM-016).';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `attachments_attachments`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `attachments_attachments` (
  `id` binary(16) NOT NULL,
  `owner_type` varchar(40) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `owner_id` binary(16) NOT NULL,
  `kind` varchar(20) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `mime_type` varchar(60) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `size_bytes` int NOT NULL,
  `sha256` char(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `storage_key` varchar(200) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `upload_status` varchar(20) COLLATE utf8mb4_0900_as_cs NOT NULL DEFAULT 'PENDING_UPLOAD',
  `uploaded_bytes` int NOT NULL DEFAULT '0',
  `captured_at` datetime(6) NOT NULL,
  `captured_lat` decimal(9,6) DEFAULT NULL,
  `captured_lng` decimal(9,6) DEFAULT NULL,
  `superseded_by_id` binary(16) DEFAULT NULL,
  `occurred_at` datetime(6) NOT NULL,
  `client_created_at` datetime(6) DEFAULT NULL,
  `received_at` datetime(6) DEFAULT NULL,
  `command_id` binary(16) DEFAULT NULL,
  `created_device_id` binary(16) DEFAULT NULL,
  `captured_offline` tinyint(1) NOT NULL DEFAULT '0',
  `clock_suspect` tinyint(1) NOT NULL DEFAULT '0',
  `backdated_reason` text COLLATE utf8mb4_0900_as_cs,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_attachments_attachments_storage_key` (`storage_key`),
  KEY `ix_attachments_attachments_owner` (`owner_type`,`owner_id`),
  KEY `ix_attachments_attachments_upload_status` (`upload_status`),
  KEY `fk_attachments_attachments_superseded_by` (`superseded_by_id`),
  KEY `fk_attachments_attachments_device` (`created_device_id`),
  KEY `fk_attachments_attachments_created_by` (`created_by`),
  CONSTRAINT `fk_attachments_attachments_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_attachments_attachments_device` FOREIGN KEY (`created_device_id`) REFERENCES `identity_devices` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_attachments_attachments_superseded_by` FOREIGN KEY (`superseded_by_id`) REFERENCES `attachments_attachments` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_attachments_attachments_kind` CHECK ((`kind` in (_utf8mb4'PHOTO',_utf8mb4'INVOICE',_utf8mb4'RECEIPT',_utf8mb4'DELIVERY_NOTE',_utf8mb4'SUPPLIER_DOCUMENT',_utf8mb4'OTHER'))),
  CONSTRAINT `ck_attachments_attachments_size` CHECK (((`size_bytes` > 0) and (`size_bytes` <= 5242880))),
  CONSTRAINT `ck_attachments_attachments_upload_status` CHECK ((`upload_status` in (_utf8mb4'PENDING_UPLOAD',_utf8mb4'AVAILABLE',_utf8mb4'QUARANTINED',_utf8mb4'MISSING',_utf8mb4'SUPERSEDED'))),
  CONSTRAINT `ck_attachments_attachments_uploaded_bytes` CHECK (((`uploaded_bytes` >= 0) and (`uploaded_bytes` <= `size_bytes`)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_attachments_attachments_update_guard` BEFORE UPDATE ON `attachments_attachments` FOR EACH ROW BEGIN
  IF NOT (
    NEW.owner_type <=> OLD.owner_type AND
    NEW.owner_id <=> OLD.owner_id AND
    NEW.kind <=> OLD.kind AND
    NEW.mime_type <=> OLD.mime_type AND
    NEW.size_bytes <=> OLD.size_bytes AND
    NEW.sha256 <=> OLD.sha256 AND
    NEW.captured_at <=> OLD.captured_at AND
    NEW.captured_lat <=> OLD.captured_lat AND
    NEW.captured_lng <=> OLD.captured_lng AND
    NEW.occurred_at <=> OLD.occurred_at AND
    NEW.client_created_at <=> OLD.client_created_at AND
    NEW.received_at <=> OLD.received_at AND
    NEW.command_id <=> OLD.command_id AND
    NEW.created_device_id <=> OLD.created_device_id AND
    NEW.captured_offline <=> OLD.captured_offline AND
    NEW.clock_suspect <=> OLD.clock_suspect AND
    NEW.backdated_reason <=> OLD.backdated_reason AND
    NEW.created_at <=> OLD.created_at AND
    NEW.created_by <=> OLD.created_by
  ) THEN
    -- MESSAGE_TEXT est limité à 128 caractères par MySQL : rester concis.
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'attachments_attachments : seul le cycle de vie de l''upload est modifiable.';
  END IF;
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_attachments_attachments_no_delete` BEFORE DELETE ON `attachments_attachments` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'attachments_attachments : suppression physique interdite (INV-GLO-03) ; remplacer (SUPERSEDED).';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `audit_audit_log`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `audit_audit_log` (
  `seq` bigint unsigned NOT NULL AUTO_INCREMENT,
  `id` binary(16) NOT NULL,
  `occurred_at` datetime(6) NOT NULL,
  `recorded_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `actor_user_id` binary(16) NOT NULL,
  `actor_roles` json NOT NULL,
  `device_id` binary(16) DEFAULT NULL,
  `ip` varchar(45) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `user_agent` varchar(300) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `captured_offline` tinyint(1) NOT NULL DEFAULT '0',
  `sync_delay_ms` bigint DEFAULT NULL,
  `clock_skew_ms` int DEFAULT NULL,
  `command_id` binary(16) DEFAULT NULL,
  `action` varchar(80) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `entity_type` varchar(40) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `entity_id` binary(16) DEFAULT NULL,
  `site_id` binary(16) DEFAULT NULL,
  `before` json DEFAULT NULL,
  `after` json DEFAULT NULL,
  `reason` text COLLATE utf8mb4_0900_as_cs,
  `approval_request_id` binary(16) DEFAULT NULL,
  `result` varchar(20) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `error_code` varchar(60) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `correlation_id` binary(16) DEFAULT NULL,
  `prev_hash` char(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `row_hash` char(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (`seq`),
  UNIQUE KEY `uq_audit_audit_log_id` (`id`),
  KEY `ix_audit_audit_log_entity` (`entity_type`,`entity_id`),
  KEY `ix_audit_audit_log_actor` (`actor_user_id`,`recorded_at`),
  KEY `ix_audit_audit_log_action` (`action`,`recorded_at`),
  KEY `ix_audit_audit_log_site` (`site_id`,`recorded_at`),
  KEY `ix_audit_audit_log_device` (`device_id`,`recorded_at`),
  CONSTRAINT `fk_audit_audit_log_actor` FOREIGN KEY (`actor_user_id`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_audit_audit_log_device` FOREIGN KEY (`device_id`) REFERENCES `identity_devices` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_audit_audit_log_result` CHECK ((`result` in (_utf8mb4'SUCCESS',_utf8mb4'DENIED',_utf8mb4'FAILED',_utf8mb4'QUARANTINED')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_audit_audit_log_no_update` BEFORE UPDATE ON `audit_audit_log` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_audit_log : aucune modification (journal en ajout seul, INV-AUD-01).';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_audit_audit_log_no_delete` BEFORE DELETE ON `audit_audit_log` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_audit_log : suppression physique interdite (INV-GLO-03, INV-AUD-01).';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `audit_chain_head`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `audit_chain_head` (
  `id` tinyint unsigned NOT NULL,
  `last_seq` bigint unsigned NOT NULL,
  `last_row_hash` char(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  CONSTRAINT `ck_audit_chain_head_singleton` CHECK ((`id` = 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `catalog_customer_categories`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `catalog_customer_categories` (
  `id` binary(16) NOT NULL,
  `code` varchar(40) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `name` varchar(200) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `updated_by` binary(16) DEFAULT NULL,
  `version` int NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_catalog_customer_categories_code` (`code`),
  KEY `fk_catalog_customer_categories_created_by` (`created_by`),
  KEY `fk_catalog_customer_categories_updated_by` (`updated_by`),
  CONSTRAINT `fk_catalog_customer_categories_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_catalog_customer_categories_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_catalog_customer_categories_no_delete` BEFORE DELETE ON `catalog_customer_categories` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'catalog_customer_categories : suppression physique interdite (INV-GLO-03) ; utiliser is_active=false.';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `catalog_product_categories`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `catalog_product_categories` (
  `id` binary(16) NOT NULL,
  `parent_id` binary(16) DEFAULT NULL,
  `code` varchar(40) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `name` varchar(200) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `updated_by` binary(16) DEFAULT NULL,
  `version` int NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_catalog_product_categories_code` (`code`),
  KEY `ix_catalog_product_categories_parent` (`parent_id`),
  KEY `fk_catalog_product_categories_created_by` (`created_by`),
  KEY `fk_catalog_product_categories_updated_by` (`updated_by`),
  CONSTRAINT `fk_catalog_product_categories_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_catalog_product_categories_parent` FOREIGN KEY (`parent_id`) REFERENCES `catalog_product_categories` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_catalog_product_categories_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_catalog_product_categories_no_delete` BEFORE DELETE ON `catalog_product_categories` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'catalog_product_categories : suppression physique interdite (INV-GLO-03) ; utiliser is_active=false.';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `catalog_product_standard_costs`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `catalog_product_standard_costs` (
  `id` binary(16) NOT NULL,
  `product_id` binary(16) NOT NULL,
  `unit_cost_xaf` bigint NOT NULL,
  `valid_from` datetime(6) NOT NULL,
  `reason` text COLLATE utf8mb4_0900_as_cs,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_catalog_product_standard_costs_version` (`product_id`,`valid_from`),
  KEY `fk_catalog_product_standard_costs_created_by` (`created_by`),
  CONSTRAINT `fk_catalog_product_standard_costs_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_catalog_product_standard_costs_product` FOREIGN KEY (`product_id`) REFERENCES `catalog_products` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_catalog_product_standard_costs_unit_cost` CHECK ((`unit_cost_xaf` >= 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_catalog_product_standard_costs_no_update` BEFORE UPDATE ON `catalog_product_standard_costs` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'catalog_product_standard_costs : aucune modification (versionnement) ; insérer une nouvelle version.';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_catalog_product_standard_costs_no_delete` BEFORE DELETE ON `catalog_product_standard_costs` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'catalog_product_standard_costs : suppression physique interdite (INV-GLO-03).';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `catalog_product_units`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `catalog_product_units` (
  `id` binary(16) NOT NULL,
  `product_id` binary(16) NOT NULL,
  `unit_code` varchar(20) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `factor_to_base` decimal(14,6) NOT NULL,
  `is_sales_unit` tinyint(1) NOT NULL DEFAULT '0',
  `is_purchase_unit` tinyint(1) NOT NULL DEFAULT '0',
  `is_count_unit` tinyint(1) NOT NULL DEFAULT '0',
  `is_active` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `updated_by` binary(16) DEFAULT NULL,
  `version` int NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_catalog_product_units_product_unit` (`product_id`,`unit_code`),
  KEY `fk_catalog_product_units_unit` (`unit_code`),
  KEY `fk_catalog_product_units_created_by` (`created_by`),
  KEY `fk_catalog_product_units_updated_by` (`updated_by`),
  CONSTRAINT `fk_catalog_product_units_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_catalog_product_units_product` FOREIGN KEY (`product_id`) REFERENCES `catalog_products` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_catalog_product_units_unit` FOREIGN KEY (`unit_code`) REFERENCES `catalog_units` (`code`) ON DELETE RESTRICT,
  CONSTRAINT `fk_catalog_product_units_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_catalog_product_units_factor` CHECK ((`factor_to_base` > 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_catalog_product_units_no_delete` BEFORE DELETE ON `catalog_product_units` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'catalog_product_units : suppression physique interdite (INV-GLO-03) ; utiliser is_active=false.';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `catalog_products`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `catalog_products` (
  `id` binary(16) NOT NULL,
  `code` varchar(40) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `name` varchar(200) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `category_id` binary(16) NOT NULL,
  `stock_family` varchar(30) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `base_unit_code` varchar(20) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `lot_tracking` varchar(10) COLLATE utf8mb4_0900_as_cs NOT NULL DEFAULT 'NONE',
  `expiry_tracking` tinyint(1) NOT NULL DEFAULT '0',
  `is_sellable` tinyint(1) NOT NULL DEFAULT '0',
  `is_purchasable` tinyint(1) NOT NULL DEFAULT '0',
  `is_producible` tinyint(1) NOT NULL DEFAULT '0',
  `is_consumable` tinyint(1) NOT NULL DEFAULT '0',
  `pricing_mode` varchar(12) COLLATE utf8mb4_0900_as_cs NOT NULL DEFAULT 'PER_UNIT',
  `species` varchar(20) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `status` varchar(10) COLLATE utf8mb4_0900_as_cs NOT NULL DEFAULT 'ACTIVE',
  `sellable_since` datetime(6) DEFAULT NULL,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `updated_by` binary(16) DEFAULT NULL,
  `version` int NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_catalog_products_code` (`code`),
  KEY `ix_catalog_products_category` (`category_id`),
  KEY `ix_catalog_products_status_sellable` (`status`,`is_sellable`),
  KEY `fk_catalog_products_base_unit` (`base_unit_code`),
  KEY `fk_catalog_products_created_by` (`created_by`),
  KEY `fk_catalog_products_updated_by` (`updated_by`),
  CONSTRAINT `fk_catalog_products_base_unit` FOREIGN KEY (`base_unit_code`) REFERENCES `catalog_units` (`code`) ON DELETE RESTRICT,
  CONSTRAINT `fk_catalog_products_category` FOREIGN KEY (`category_id`) REFERENCES `catalog_product_categories` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_catalog_products_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_catalog_products_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_catalog_products_lot_tracking` CHECK ((`lot_tracking` in (_utf8mb4'REQUIRED',_utf8mb4'OPTIONAL',_utf8mb4'NONE'))),
  CONSTRAINT `ck_catalog_products_pricing_mode` CHECK ((`pricing_mode` in (_utf8mb4'PER_UNIT',_utf8mb4'PER_WEIGHT'))),
  CONSTRAINT `ck_catalog_products_service_no_lot` CHECK (((`stock_family` <> _utf8mb4'SERVICE') or (`lot_tracking` = _utf8mb4'NONE'))),
  CONSTRAINT `ck_catalog_products_species` CHECK (((`species` is null) or (`species` in (_utf8mb4'POULET_CHAIR',_utf8mb4'PONDEUSE',_utf8mb4'PORC')))),
  CONSTRAINT `ck_catalog_products_species_required` CHECK (((`stock_family` <> _utf8mb4'BIOLOGIQUE') or (`species` is not null))),
  CONSTRAINT `ck_catalog_products_status` CHECK ((`status` in (_utf8mb4'ACTIVE',_utf8mb4'INACTIVE'))),
  CONSTRAINT `ck_catalog_products_stock_family` CHECK ((`stock_family` in (_utf8mb4'BIOLOGIQUE',_utf8mb4'PRODUCTION_COMMERCIALISABLE',_utf8mb4'INTRANT',_utf8mb4'MARCHANDISE',_utf8mb4'EMBALLAGE_CONSOMMABLE',_utf8mb4'SERVICE')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_catalog_products_no_delete` BEFORE DELETE ON `catalog_products` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'catalog_products : suppression physique interdite (INV-GLO-03) ; utiliser status=INACTIVE.';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `catalog_reason_codes`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `catalog_reason_codes` (
  `id` binary(16) NOT NULL,
  `category` varchar(30) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `code` varchar(40) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `label` varchar(200) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `loss_category` varchar(30) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `requires_comment` tinyint(1) NOT NULL DEFAULT '0',
  `is_active` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `updated_by` binary(16) DEFAULT NULL,
  `version` int NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_catalog_reason_codes_category_code` (`category`,`code`),
  KEY `fk_catalog_reason_codes_created_by` (`created_by`),
  KEY `fk_catalog_reason_codes_updated_by` (`updated_by`),
  CONSTRAINT `fk_catalog_reason_codes_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_catalog_reason_codes_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_catalog_reason_codes_category` CHECK ((`category` in (_utf8mb4'LOSS',_utf8mb4'REJECTION',_utf8mb4'INVENTORY_ADJUSTMENT',_utf8mb4'CANCELLATION',_utf8mb4'PRICE_OVERRIDE',_utf8mb4'VISIT_OUTCOME',_utf8mb4'PROSPECT_LOST',_utf8mb4'CHECKIN_OVERRIDE',_utf8mb4'PRODUCTION_YIELD',_utf8mb4'CASH_VARIANCE',_utf8mb4'TRANSFER_DISCREPANCY')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_catalog_reason_codes_no_delete` BEFORE DELETE ON `catalog_reason_codes` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'catalog_reason_codes : suppression physique interdite (BR-CAT-010) ; utiliser is_active=false.';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `catalog_sales_channels`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `catalog_sales_channels` (
  `code` varchar(20) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `name` varchar(60) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT '1',
  PRIMARY KEY (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_catalog_sales_channels_no_delete` BEFORE DELETE ON `catalog_sales_channels` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'catalog_sales_channels : suppression physique interdite (INV-GLO-03) ; utiliser is_active=false.';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `catalog_units`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `catalog_units` (
  `code` varchar(20) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `name` varchar(60) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `is_count` tinyint(1) NOT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT '1',
  PRIMARY KEY (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_catalog_units_no_delete` BEFORE DELETE ON `catalog_units` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'catalog_units : suppression physique interdite (INV-GLO-03) ; utiliser is_active=false.';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `crm_customer_assignments`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `crm_customer_assignments` (
  `id` binary(16) NOT NULL,
  `customer_id` binary(16) NOT NULL,
  `user_id` binary(16) NOT NULL,
  `valid_from` datetime(6) NOT NULL,
  `valid_to` datetime(6) DEFAULT NULL,
  `assigned_by` binary(16) NOT NULL,
  `reason` text COLLATE utf8mb4_0900_as_cs,
  `command_id` binary(16) DEFAULT NULL,
  `active_key` binary(16) GENERATED ALWAYS AS ((case when (`valid_to` is null) then `customer_id` end)) STORED,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_crm_customer_assignments_active` (`active_key`),
  KEY `ix_crm_customer_assignments_user` (`user_id`,`valid_from`),
  KEY `ix_crm_customer_assignments_customer` (`customer_id`,`valid_from`),
  KEY `fk_crm_customer_assignments_assigned_by` (`assigned_by`),
  CONSTRAINT `fk_crm_customer_assignments_assigned_by` FOREIGN KEY (`assigned_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_crm_customer_assignments_customer` FOREIGN KEY (`customer_id`) REFERENCES `crm_customers` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_crm_customer_assignments_user` FOREIGN KEY (`user_id`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_crm_customer_assignments_period` CHECK (((`valid_to` is null) or (`valid_to` >= `valid_from`)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_crm_customer_assignments_overlap_ins` BEFORE INSERT ON `crm_customer_assignments` FOR EACH ROW BEGIN
  IF EXISTS (
    SELECT 1 FROM crm_customer_assignments
    WHERE customer_id = NEW.customer_id
      AND id <> NEW.id
      AND valid_from < COALESCE(NEW.valid_to, '9999-12-31 23:59:59.999999')
      AND COALESCE(valid_to, '9999-12-31 23:59:59.999999') > NEW.valid_from
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'crm_customer_assignments : périodes de titulaire chevauchantes (INV-CRM-02).';
  END IF;
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_crm_customer_assignments_update_guard` BEFORE UPDATE ON `crm_customer_assignments` FOR EACH ROW BEGIN
  IF NOT (
    NEW.customer_id <=> OLD.customer_id AND
    NEW.user_id <=> OLD.user_id AND
    NEW.valid_from <=> OLD.valid_from AND
    NEW.assigned_by <=> OLD.assigned_by AND
    NEW.reason <=> OLD.reason AND
    NEW.command_id <=> OLD.command_id AND
    NEW.created_at <=> OLD.created_at
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'crm_customer_assignments : seule la fermeture (valid_to) est modifiable.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM crm_customer_assignments
    WHERE customer_id = NEW.customer_id
      AND id <> NEW.id
      AND valid_from < COALESCE(NEW.valid_to, '9999-12-31 23:59:59.999999')
      AND COALESCE(valid_to, '9999-12-31 23:59:59.999999') > NEW.valid_from
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'crm_customer_assignments : périodes de titulaire chevauchantes (INV-CRM-02).';
  END IF;
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_crm_customer_assignments_no_delete` BEFORE DELETE ON `crm_customer_assignments` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'crm_customer_assignments : suppression physique interdite ; fermer par valid_to.';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `crm_customer_stage_history`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `crm_customer_stage_history` (
  `id` binary(16) NOT NULL,
  `customer_id` binary(16) NOT NULL,
  `from_stage` varchar(10) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `to_stage` varchar(10) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `from_step_id` binary(16) DEFAULT NULL,
  `to_step_id` binary(16) DEFAULT NULL,
  `occurred_at` datetime(6) NOT NULL,
  `actor_user_id` binary(16) NOT NULL,
  `reason_code_id` binary(16) DEFAULT NULL,
  `cause_ref` binary(16) DEFAULT NULL,
  `command_id` binary(16) DEFAULT NULL,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  KEY `ix_crm_customer_stage_history_customer` (`customer_id`,`occurred_at`),
  KEY `fk_crm_customer_stage_history_from_step` (`from_step_id`),
  KEY `fk_crm_customer_stage_history_to_step` (`to_step_id`),
  KEY `fk_crm_customer_stage_history_actor` (`actor_user_id`),
  KEY `fk_crm_customer_stage_history_reason` (`reason_code_id`),
  CONSTRAINT `fk_crm_customer_stage_history_actor` FOREIGN KEY (`actor_user_id`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_crm_customer_stage_history_customer` FOREIGN KEY (`customer_id`) REFERENCES `crm_customers` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_crm_customer_stage_history_from_step` FOREIGN KEY (`from_step_id`) REFERENCES `crm_pipeline_steps` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_crm_customer_stage_history_reason` FOREIGN KEY (`reason_code_id`) REFERENCES `catalog_reason_codes` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_crm_customer_stage_history_to_step` FOREIGN KEY (`to_step_id`) REFERENCES `crm_pipeline_steps` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_crm_customer_stage_history_stages` CHECK ((((`from_stage` is null) or (`from_stage` in (_utf8mb4'PROSPECT',_utf8mb4'CUSTOMER',_utf8mb4'LOST',_utf8mb4'MERGED'))) and (`to_stage` in (_utf8mb4'PROSPECT',_utf8mb4'CUSTOMER',_utf8mb4'LOST',_utf8mb4'MERGED'))))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_crm_customer_stage_history_no_update` BEFORE UPDATE ON `crm_customer_stage_history` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'crm_customer_stage_history : historique immuable (BR-CRM-008).';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_crm_customer_stage_history_no_delete` BEFORE DELETE ON `crm_customer_stage_history` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'crm_customer_stage_history : suppression physique interdite (BR-CRM-008).';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `crm_customers`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `crm_customers` (
  `id` binary(16) NOT NULL,
  `stage` varchar(10) COLLATE utf8mb4_0900_as_cs NOT NULL DEFAULT 'PROSPECT',
  `pipeline_step_id` binary(16) DEFAULT NULL,
  `customer_type` varchar(12) COLLATE utf8mb4_0900_as_cs NOT NULL DEFAULT 'PARTICULIER',
  `display_name` varchar(200) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `contact_name` varchar(200) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `business_activity` varchar(200) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `category_id` binary(16) DEFAULT NULL,
  `phone_primary` varchar(20) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `phone_secondary` varchar(20) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `email` varchar(200) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `address_text` text COLLATE utf8mb4_0900_as_cs,
  `zone_id` binary(16) NOT NULL,
  `lat` decimal(9,6) DEFAULT NULL,
  `lng` decimal(9,6) DEFAULT NULL,
  `geo_accuracy_m` decimal(8,1) DEFAULT NULL,
  `source_code` varchar(40) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `acquired_by_user_id` binary(16) NOT NULL,
  `acquired_at` datetime(6) NOT NULL,
  `owner_user_id` binary(16) DEFAULT NULL,
  `home_site_id` binary(16) DEFAULT NULL,
  `converted_at` datetime(6) DEFAULT NULL,
  `first_sale_id` binary(16) DEFAULT NULL,
  `conversion_reverted` tinyint(1) NOT NULL DEFAULT '0',
  `lost_reason_code_id` binary(16) DEFAULT NULL,
  `merged_into_id` binary(16) DEFAULT NULL,
  `duplicate_of_id` binary(16) DEFAULT NULL,
  `credit_allowed` tinyint(1) NOT NULL DEFAULT '0',
  `credit_limit_xaf` bigint DEFAULT NULL,
  `payment_terms_days` smallint DEFAULT NULL,
  `last_sale_at` datetime(6) DEFAULT NULL,
  `field_versions` json NOT NULL DEFAULT (json_object()),
  `phone_key` varchar(20) COLLATE utf8mb4_0900_as_cs GENERATED ALWAYS AS ((case when ((`stage` <> _utf8mb4'MERGED') and (`duplicate_of_id` is null)) then `phone_primary` end)) STORED,
  `occurred_at` datetime(6) NOT NULL,
  `client_created_at` datetime(6) DEFAULT NULL,
  `received_at_server` datetime(6) DEFAULT NULL,
  `command_id` binary(16) DEFAULT NULL,
  `created_device_id` binary(16) DEFAULT NULL,
  `captured_offline` tinyint(1) NOT NULL DEFAULT '0',
  `clock_suspect` tinyint(1) NOT NULL DEFAULT '0',
  `backdated_reason` text COLLATE utf8mb4_0900_as_cs,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `updated_by` binary(16) DEFAULT NULL,
  `version` int NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_crm_customers_phone` (`phone_key`),
  UNIQUE KEY `uq_crm_customers_command` (`command_id`),
  KEY `ix_crm_customers_owner` (`owner_user_id`),
  KEY `ix_crm_customers_zone` (`zone_id`),
  KEY `ix_crm_customers_stage` (`stage`),
  KEY `ix_crm_customers_home_site` (`home_site_id`),
  KEY `ix_crm_customers_acquired` (`acquired_by_user_id`,`acquired_at`),
  KEY `ix_crm_customers_phone_primary` (`phone_primary`),
  KEY `fk_crm_customers_step` (`pipeline_step_id`),
  KEY `fk_crm_customers_category` (`category_id`),
  KEY `fk_crm_customers_source` (`source_code`),
  KEY `fk_crm_customers_lost_reason` (`lost_reason_code_id`),
  KEY `fk_crm_customers_merged_into` (`merged_into_id`),
  KEY `fk_crm_customers_duplicate_of` (`duplicate_of_id`),
  KEY `fk_crm_customers_created_device` (`created_device_id`),
  KEY `fk_crm_customers_created_by` (`created_by`),
  KEY `fk_crm_customers_updated_by` (`updated_by`),
  FULLTEXT KEY `ftx_crm_customers_display_name` (`display_name`) /*!50100 WITH PARSER `ngram` */ ,
  CONSTRAINT `fk_crm_customers_acquired_by` FOREIGN KEY (`acquired_by_user_id`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_crm_customers_category` FOREIGN KEY (`category_id`) REFERENCES `catalog_customer_categories` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_crm_customers_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_crm_customers_created_device` FOREIGN KEY (`created_device_id`) REFERENCES `identity_devices` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_crm_customers_duplicate_of` FOREIGN KEY (`duplicate_of_id`) REFERENCES `crm_customers` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_crm_customers_home_site` FOREIGN KEY (`home_site_id`) REFERENCES `organization_sites` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_crm_customers_lost_reason` FOREIGN KEY (`lost_reason_code_id`) REFERENCES `catalog_reason_codes` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_crm_customers_merged_into` FOREIGN KEY (`merged_into_id`) REFERENCES `crm_customers` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_crm_customers_owner` FOREIGN KEY (`owner_user_id`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_crm_customers_source` FOREIGN KEY (`source_code`) REFERENCES `crm_lead_sources` (`code`) ON DELETE RESTRICT,
  CONSTRAINT `fk_crm_customers_step` FOREIGN KEY (`pipeline_step_id`) REFERENCES `crm_pipeline_steps` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_crm_customers_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_crm_customers_zone` FOREIGN KEY (`zone_id`) REFERENCES `organization_zones` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_crm_customers_credit` CHECK ((((`credit_limit_xaf` is null) or (`credit_limit_xaf` >= 0)) and ((`payment_terms_days` is null) or (`payment_terms_days` >= 0)))),
  CONSTRAINT `ck_crm_customers_customer` CHECK (((`stage` <> _utf8mb4'CUSTOMER') or (`first_sale_id` is not null))),
  CONSTRAINT `ck_crm_customers_findable` CHECK (((`phone_primary` is not null) or ((`lat` is not null) and (`lng` is not null)))),
  CONSTRAINT `ck_crm_customers_lost` CHECK (((`stage` <> _utf8mb4'LOST') or (`lost_reason_code_id` is not null))),
  CONSTRAINT `ck_crm_customers_merged` CHECK ((((`stage` = _utf8mb4'MERGED') and (`merged_into_id` is not null)) or ((`stage` <> _utf8mb4'MERGED') and (`merged_into_id` is null)))),
  CONSTRAINT `ck_crm_customers_position` CHECK ((((`lat` is null) and (`lng` is null)) or ((`lat` is not null) and (`lng` is not null)))),
  CONSTRAINT `ck_crm_customers_prospect_step` CHECK (((`stage` <> _utf8mb4'PROSPECT') or (`pipeline_step_id` is not null))),
  CONSTRAINT `ck_crm_customers_ranges` CHECK ((((`lat` is null) or (`lat` between -(90) and 90)) and ((`lng` is null) or (`lng` between -(180) and 180)) and ((`geo_accuracy_m` is null) or (`geo_accuracy_m` >= 0)))),
  CONSTRAINT `ck_crm_customers_self_refs` CHECK ((((`merged_into_id` is null) or (`merged_into_id` <> `id`)) and ((`duplicate_of_id` is null) or (`duplicate_of_id` <> `id`)))),
  CONSTRAINT `ck_crm_customers_stage` CHECK ((`stage` in (_utf8mb4'PROSPECT',_utf8mb4'CUSTOMER',_utf8mb4'LOST',_utf8mb4'MERGED'))),
  CONSTRAINT `ck_crm_customers_type` CHECK ((`customer_type` in (_utf8mb4'PARTICULIER',_utf8mb4'ENTREPRISE')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_crm_customers_update_guard` BEFORE UPDATE ON `crm_customers` FOR EACH ROW BEGIN
  IF NOT (
    NEW.acquired_by_user_id <=> OLD.acquired_by_user_id AND
    NEW.acquired_at <=> OLD.acquired_at AND
    NEW.occurred_at <=> OLD.occurred_at AND
    NEW.command_id <=> OLD.command_id AND
    NEW.created_device_id <=> OLD.created_device_id AND
    NEW.created_at <=> OLD.created_at AND
    NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'crm_customers : acquéreur et date d''acquisition immuables (INV-CRM-01).';
  END IF;
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_crm_customers_no_delete` BEFORE DELETE ON `crm_customers` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'crm_customers : suppression physique interdite (INV-GLO-03) ; fusionner ou marquer perdu.';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `crm_interactions`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `crm_interactions` (
  `id` binary(16) NOT NULL,
  `customer_id` binary(16) NOT NULL,
  `user_id` binary(16) NOT NULL,
  `channel` varchar(10) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `direction` varchar(10) COLLATE utf8mb4_0900_as_cs NOT NULL DEFAULT 'SORTANT',
  `summary` text COLLATE utf8mb4_0900_as_cs,
  `next_action_at` date DEFAULT NULL,
  `next_action_note` text COLLATE utf8mb4_0900_as_cs,
  `status` varchar(10) COLLATE utf8mb4_0900_as_cs NOT NULL DEFAULT 'RECORDED',
  `cancelled_at` datetime(6) DEFAULT NULL,
  `cancelled_by` binary(16) DEFAULT NULL,
  `cancel_reason_code_id` binary(16) DEFAULT NULL,
  `cancel_comment` text COLLATE utf8mb4_0900_as_cs,
  `cancel_approval_request_id` binary(16) DEFAULT NULL,
  `occurred_at` datetime(6) NOT NULL,
  `client_created_at` datetime(6) DEFAULT NULL,
  `received_at_server` datetime(6) DEFAULT NULL,
  `command_id` binary(16) DEFAULT NULL,
  `created_device_id` binary(16) DEFAULT NULL,
  `captured_offline` tinyint(1) NOT NULL DEFAULT '0',
  `clock_suspect` tinyint(1) NOT NULL DEFAULT '0',
  `backdated_reason` text COLLATE utf8mb4_0900_as_cs,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `updated_by` binary(16) DEFAULT NULL,
  `version` int NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_crm_interactions_command` (`command_id`),
  KEY `ix_crm_interactions_user_occurred` (`user_id`,`occurred_at`),
  KEY `ix_crm_interactions_customer_occurred` (`customer_id`,`occurred_at`),
  KEY `fk_crm_interactions_cancelled_by` (`cancelled_by`),
  KEY `fk_crm_interactions_cancel_reason` (`cancel_reason_code_id`),
  KEY `fk_crm_interactions_cancel_approval` (`cancel_approval_request_id`),
  KEY `fk_crm_interactions_created_device` (`created_device_id`),
  KEY `fk_crm_interactions_created_by` (`created_by`),
  KEY `fk_crm_interactions_updated_by` (`updated_by`),
  CONSTRAINT `fk_crm_interactions_cancel_approval` FOREIGN KEY (`cancel_approval_request_id`) REFERENCES `approvals_approval_requests` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_crm_interactions_cancel_reason` FOREIGN KEY (`cancel_reason_code_id`) REFERENCES `catalog_reason_codes` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_crm_interactions_cancelled_by` FOREIGN KEY (`cancelled_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_crm_interactions_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_crm_interactions_created_device` FOREIGN KEY (`created_device_id`) REFERENCES `identity_devices` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_crm_interactions_customer` FOREIGN KEY (`customer_id`) REFERENCES `crm_customers` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_crm_interactions_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_crm_interactions_user` FOREIGN KEY (`user_id`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_crm_interactions_cancel` CHECK ((((`status` = _utf8mb4'CANCELLED') and (`cancelled_at` is not null) and (`cancelled_by` is not null)) or ((`status` <> _utf8mb4'CANCELLED') and (`cancelled_at` is null) and (`cancelled_by` is null) and (`cancel_reason_code_id` is null) and (`cancel_comment` is null)))),
  CONSTRAINT `ck_crm_interactions_channel` CHECK ((`channel` in (_utf8mb4'APPEL',_utf8mb4'SMS',_utf8mb4'EMAIL',_utf8mb4'AUTRE'))),
  CONSTRAINT `ck_crm_interactions_direction` CHECK ((`direction` in (_utf8mb4'ENTRANT',_utf8mb4'SORTANT'))),
  CONSTRAINT `ck_crm_interactions_status` CHECK ((`status` in (_utf8mb4'RECORDED',_utf8mb4'CANCELLED')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_crm_interactions_update_guard` BEFORE UPDATE ON `crm_interactions` FOR EACH ROW BEGIN
  IF NOT (
    NEW.customer_id <=> OLD.customer_id AND
    NEW.user_id <=> OLD.user_id AND
    NEW.channel <=> OLD.channel AND
    NEW.direction <=> OLD.direction AND
    NEW.summary <=> OLD.summary AND
    NEW.next_action_at <=> OLD.next_action_at AND
    NEW.next_action_note <=> OLD.next_action_note AND
    NEW.occurred_at <=> OLD.occurred_at AND
    NEW.command_id <=> OLD.command_id AND
    NEW.created_at <=> OLD.created_at AND
    NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'crm_interactions : interaction non modifiable ; l''annuler et en saisir une nouvelle (BR-CRM-016).';
  END IF;
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_crm_interactions_no_delete` BEFORE DELETE ON `crm_interactions` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'crm_interactions : suppression physique interdite (INV-GLO-03) ; utiliser CANCELLED.';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `crm_lead_sources`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `crm_lead_sources` (
  `id` binary(16) NOT NULL,
  `code` varchar(40) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `label` varchar(200) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `sort_order` smallint NOT NULL DEFAULT '0',
  `is_active` tinyint(1) NOT NULL DEFAULT '1',
  `is_system` tinyint(1) NOT NULL DEFAULT '0',
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `updated_by` binary(16) DEFAULT NULL,
  `version` int NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_crm_lead_sources_code` (`code`),
  KEY `fk_crm_lead_sources_created_by` (`created_by`),
  KEY `fk_crm_lead_sources_updated_by` (`updated_by`),
  CONSTRAINT `fk_crm_lead_sources_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_crm_lead_sources_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_crm_lead_sources_system` CHECK (((`is_system` = false) or (`is_active` = true)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_crm_lead_sources_update_guard` BEFORE UPDATE ON `crm_lead_sources` FOR EACH ROW BEGIN
  IF NOT (NEW.code <=> OLD.code AND NEW.created_at <=> OLD.created_at AND NEW.created_by <=> OLD.created_by) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'crm_lead_sources : le code est immuable.';
  END IF;
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_crm_lead_sources_no_delete` BEFORE DELETE ON `crm_lead_sources` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'crm_lead_sources : suppression physique interdite ; utiliser is_active=false.';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `crm_pipeline_steps`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `crm_pipeline_steps` (
  `id` binary(16) NOT NULL,
  `code` varchar(40) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `label` varchar(200) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `sort_order` smallint NOT NULL DEFAULT '0',
  `is_active` tinyint(1) NOT NULL DEFAULT '1',
  `is_system` tinyint(1) NOT NULL DEFAULT '0',
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `updated_by` binary(16) DEFAULT NULL,
  `version` int NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_crm_pipeline_steps_code` (`code`),
  KEY `ix_crm_pipeline_steps_order` (`is_active`,`sort_order`),
  KEY `fk_crm_pipeline_steps_created_by` (`created_by`),
  KEY `fk_crm_pipeline_steps_updated_by` (`updated_by`),
  CONSTRAINT `fk_crm_pipeline_steps_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_crm_pipeline_steps_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_crm_pipeline_steps_system` CHECK (((`is_system` = false) or (`is_active` = true)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_crm_pipeline_steps_update_guard` BEFORE UPDATE ON `crm_pipeline_steps` FOR EACH ROW BEGIN
  IF NOT (NEW.code <=> OLD.code AND NEW.created_at <=> OLD.created_at AND NEW.created_by <=> OLD.created_by) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'crm_pipeline_steps : le code est immuable.';
  END IF;
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_crm_pipeline_steps_no_delete` BEFORE DELETE ON `crm_pipeline_steps` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'crm_pipeline_steps : suppression physique interdite ; utiliser is_active=false.';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `crm_sales_targets`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `crm_sales_targets` (
  `id` binary(16) NOT NULL,
  `target_type` varchar(5) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `user_id` binary(16) DEFAULT NULL,
  `team_id` binary(16) DEFAULT NULL,
  `site_id` binary(16) DEFAULT NULL,
  `metric` varchar(20) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `product_id` binary(16) DEFAULT NULL,
  `period_start` date NOT NULL,
  `period_end` date NOT NULL,
  `target_value` decimal(16,3) NOT NULL,
  `status` varchar(10) COLLATE utf8mb4_0900_as_cs NOT NULL DEFAULT 'ACTIVE',
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `updated_by` binary(16) DEFAULT NULL,
  `version` int NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`),
  KEY `ix_crm_sales_targets_user` (`user_id`,`period_start`),
  KEY `ix_crm_sales_targets_team` (`team_id`,`period_start`),
  KEY `ix_crm_sales_targets_site` (`site_id`,`period_start`),
  KEY `fk_crm_sales_targets_product` (`product_id`),
  KEY `fk_crm_sales_targets_created_by` (`created_by`),
  KEY `fk_crm_sales_targets_updated_by` (`updated_by`),
  CONSTRAINT `fk_crm_sales_targets_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_crm_sales_targets_product` FOREIGN KEY (`product_id`) REFERENCES `catalog_products` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_crm_sales_targets_site` FOREIGN KEY (`site_id`) REFERENCES `organization_sites` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_crm_sales_targets_team` FOREIGN KEY (`team_id`) REFERENCES `organization_teams` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_crm_sales_targets_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_crm_sales_targets_user` FOREIGN KEY (`user_id`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_crm_sales_targets_metric` CHECK ((`metric` in (_utf8mb4'CA',_utf8mb4'QTE_PRODUIT',_utf8mb4'NOUVEAUX_CLIENTS',_utf8mb4'VISITES',_utf8mb4'PROSPECTS_CREES'))),
  CONSTRAINT `ck_crm_sales_targets_period` CHECK ((`period_end` >= `period_start`)),
  CONSTRAINT `ck_crm_sales_targets_product` CHECK (((`metric` <> _utf8mb4'QTE_PRODUIT') or (`product_id` is not null))),
  CONSTRAINT `ck_crm_sales_targets_status` CHECK ((`status` in (_utf8mb4'ACTIVE',_utf8mb4'CANCELLED'))),
  CONSTRAINT `ck_crm_sales_targets_target` CHECK ((((`target_type` = _utf8mb4'USER') and (`user_id` is not null) and (`team_id` is null) and (`site_id` is null)) or ((`target_type` = _utf8mb4'TEAM') and (`team_id` is not null) and (`user_id` is null) and (`site_id` is null)) or ((`target_type` = _utf8mb4'SITE') and (`site_id` is not null) and (`user_id` is null) and (`team_id` is null)))),
  CONSTRAINT `ck_crm_sales_targets_type` CHECK ((`target_type` in (_utf8mb4'USER',_utf8mb4'TEAM',_utf8mb4'SITE'))),
  CONSTRAINT `ck_crm_sales_targets_value` CHECK ((`target_value` > 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_crm_sales_targets_overlap_ins` BEFORE INSERT ON `crm_sales_targets` FOR EACH ROW BEGIN
  IF NEW.status = 'ACTIVE' AND EXISTS (
    SELECT 1 FROM crm_sales_targets
    WHERE id <> NEW.id AND status = 'ACTIVE'
      AND target_type = NEW.target_type
      AND user_id <=> NEW.user_id AND team_id <=> NEW.team_id AND site_id <=> NEW.site_id
      AND metric = NEW.metric AND product_id <=> NEW.product_id
      AND period_start <= NEW.period_end AND period_end >= NEW.period_start
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'crm_sales_targets : objectif actif chevauchant (BR-CRM-018).';
  END IF;
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_crm_sales_targets_update_guard` BEFORE UPDATE ON `crm_sales_targets` FOR EACH ROW BEGIN
  IF NOT (
    NEW.target_type <=> OLD.target_type AND
    NEW.user_id <=> OLD.user_id AND
    NEW.team_id <=> OLD.team_id AND
    NEW.site_id <=> OLD.site_id AND
    NEW.metric <=> OLD.metric AND
    NEW.product_id <=> OLD.product_id AND
    NEW.period_start <=> OLD.period_start AND
    NEW.period_end <=> OLD.period_end AND
    NEW.target_value <=> OLD.target_value AND
    NEW.created_at <=> OLD.created_at AND
    NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'crm_sales_targets : objectif non modifiable ; l''annuler et en définir un nouveau.';
  END IF;
  IF NEW.status = 'ACTIVE' AND EXISTS (
    SELECT 1 FROM crm_sales_targets
    WHERE id <> NEW.id AND status = 'ACTIVE'
      AND target_type = NEW.target_type
      AND user_id <=> NEW.user_id AND team_id <=> NEW.team_id AND site_id <=> NEW.site_id
      AND metric = NEW.metric AND product_id <=> NEW.product_id
      AND period_start <= NEW.period_end AND period_end >= NEW.period_start
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'crm_sales_targets : objectif actif chevauchant (BR-CRM-018).';
  END IF;
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_crm_sales_targets_no_delete` BEFORE DELETE ON `crm_sales_targets` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'crm_sales_targets : suppression physique interdite ; utiliser CANCELLED.';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `crm_visits`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `crm_visits` (
  `id` binary(16) NOT NULL,
  `customer_id` binary(16) NOT NULL,
  `user_id` binary(16) NOT NULL,
  `work_session_id` binary(16) DEFAULT NULL,
  `customer_stage_at_visit` varchar(10) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `lat` decimal(9,6) DEFAULT NULL,
  `lng` decimal(9,6) DEFAULT NULL,
  `accuracy_m` decimal(8,1) DEFAULT NULL,
  `distance_to_customer_m` decimal(8,1) DEFAULT NULL,
  `outcome_reason_code_id` binary(16) NOT NULL,
  `notes` text COLLATE utf8mb4_0900_as_cs,
  `next_action_at` date DEFAULT NULL,
  `next_action_note` text COLLATE utf8mb4_0900_as_cs,
  `flags` json NOT NULL DEFAULT (json_array()),
  `status` varchar(10) COLLATE utf8mb4_0900_as_cs NOT NULL DEFAULT 'RECORDED',
  `open_next_action_at` date GENERATED ALWAYS AS ((case when (`status` = _utf8mb4'RECORDED') then `next_action_at` end)) STORED,
  `cancelled_at` datetime(6) DEFAULT NULL,
  `cancelled_by` binary(16) DEFAULT NULL,
  `cancel_reason_code_id` binary(16) DEFAULT NULL,
  `cancel_comment` text COLLATE utf8mb4_0900_as_cs,
  `cancel_approval_request_id` binary(16) DEFAULT NULL,
  `occurred_at` datetime(6) NOT NULL,
  `client_created_at` datetime(6) DEFAULT NULL,
  `received_at_server` datetime(6) DEFAULT NULL,
  `command_id` binary(16) DEFAULT NULL,
  `created_device_id` binary(16) DEFAULT NULL,
  `captured_offline` tinyint(1) NOT NULL DEFAULT '0',
  `clock_suspect` tinyint(1) NOT NULL DEFAULT '0',
  `backdated_reason` text COLLATE utf8mb4_0900_as_cs,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `updated_by` binary(16) DEFAULT NULL,
  `version` int NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_crm_visits_command` (`command_id`),
  KEY `ix_crm_visits_user_occurred` (`user_id`,`occurred_at`),
  KEY `ix_crm_visits_customer_occurred` (`customer_id`,`occurred_at`),
  KEY `ix_crm_visits_next_action` (`open_next_action_at`),
  KEY `ix_crm_visits_session` (`work_session_id`),
  KEY `fk_crm_visits_outcome` (`outcome_reason_code_id`),
  KEY `fk_crm_visits_cancelled_by` (`cancelled_by`),
  KEY `fk_crm_visits_cancel_reason` (`cancel_reason_code_id`),
  KEY `fk_crm_visits_cancel_approval` (`cancel_approval_request_id`),
  KEY `fk_crm_visits_created_device` (`created_device_id`),
  KEY `fk_crm_visits_created_by` (`created_by`),
  KEY `fk_crm_visits_updated_by` (`updated_by`),
  CONSTRAINT `fk_crm_visits_cancel_approval` FOREIGN KEY (`cancel_approval_request_id`) REFERENCES `approvals_approval_requests` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_crm_visits_cancel_reason` FOREIGN KEY (`cancel_reason_code_id`) REFERENCES `catalog_reason_codes` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_crm_visits_cancelled_by` FOREIGN KEY (`cancelled_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_crm_visits_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_crm_visits_created_device` FOREIGN KEY (`created_device_id`) REFERENCES `identity_devices` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_crm_visits_customer` FOREIGN KEY (`customer_id`) REFERENCES `crm_customers` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_crm_visits_outcome` FOREIGN KEY (`outcome_reason_code_id`) REFERENCES `catalog_reason_codes` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_crm_visits_session` FOREIGN KEY (`work_session_id`) REFERENCES `fieldwork_work_sessions` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_crm_visits_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_crm_visits_user` FOREIGN KEY (`user_id`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_crm_visits_cancel` CHECK ((((`status` = _utf8mb4'CANCELLED') and (`cancelled_at` is not null) and (`cancelled_by` is not null)) or ((`status` <> _utf8mb4'CANCELLED') and (`cancelled_at` is null) and (`cancelled_by` is null) and (`cancel_reason_code_id` is null) and (`cancel_comment` is null)))),
  CONSTRAINT `ck_crm_visits_position` CHECK ((((`lat` is null) and (`lng` is null)) or ((`lat` is not null) and (`lng` is not null)))),
  CONSTRAINT `ck_crm_visits_ranges` CHECK ((((`lat` is null) or (`lat` between -(90) and 90)) and ((`lng` is null) or (`lng` between -(180) and 180)) and ((`accuracy_m` is null) or (`accuracy_m` >= 0)))),
  CONSTRAINT `ck_crm_visits_stage` CHECK ((`customer_stage_at_visit` in (_utf8mb4'PROSPECT',_utf8mb4'CUSTOMER',_utf8mb4'LOST',_utf8mb4'MERGED'))),
  CONSTRAINT `ck_crm_visits_status` CHECK ((`status` in (_utf8mb4'RECORDED',_utf8mb4'CANCELLED')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_crm_visits_update_guard` BEFORE UPDATE ON `crm_visits` FOR EACH ROW BEGIN
  IF NOT (
    NEW.customer_id <=> OLD.customer_id AND
    NEW.user_id <=> OLD.user_id AND
    NEW.work_session_id <=> OLD.work_session_id AND
    NEW.customer_stage_at_visit <=> OLD.customer_stage_at_visit AND
    NEW.lat <=> OLD.lat AND
    NEW.lng <=> OLD.lng AND
    NEW.accuracy_m <=> OLD.accuracy_m AND
    NEW.distance_to_customer_m <=> OLD.distance_to_customer_m AND
    NEW.outcome_reason_code_id <=> OLD.outcome_reason_code_id AND
    NEW.notes <=> OLD.notes AND
    NEW.next_action_at <=> OLD.next_action_at AND
    NEW.next_action_note <=> OLD.next_action_note AND
    NEW.occurred_at <=> OLD.occurred_at AND
    NEW.command_id <=> OLD.command_id AND
    NEW.created_at <=> OLD.created_at AND
    NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'crm_visits : visite non modifiable ; l''annuler et en saisir une nouvelle (BR-CRM-016).';
  END IF;
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_crm_visits_no_delete` BEFORE DELETE ON `crm_visits` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'crm_visits : suppression physique interdite (INV-GLO-03) ; utiliser CANCELLED.';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `fieldwork_geo_checkins`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `fieldwork_geo_checkins` (
  `id` binary(16) NOT NULL,
  `user_id` binary(16) NOT NULL,
  `checkin_type` varchar(15) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `declared_zone_id` binary(16) NOT NULL,
  `lat` decimal(9,6) DEFAULT NULL,
  `lng` decimal(9,6) DEFAULT NULL,
  `accuracy_m` decimal(8,1) DEFAULT NULL,
  `geofence_lat` decimal(9,6) DEFAULT NULL,
  `geofence_lng` decimal(9,6) DEFAULT NULL,
  `geofence_radius_m` decimal(8,1) DEFAULT NULL,
  `max_accuracy_m` decimal(8,1) DEFAULT NULL,
  `distance_m` decimal(8,1) DEFAULT NULL,
  `client_result` varchar(25) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `server_result` varchar(25) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `result_divergence` tinyint(1) NOT NULL DEFAULT '0',
  `work_session_id` binary(16) DEFAULT NULL,
  `suspicion_flags` json NOT NULL DEFAULT (json_array()),
  `occurred_at` datetime(6) NOT NULL,
  `client_created_at` datetime(6) DEFAULT NULL,
  `received_at_server` datetime(6) DEFAULT NULL,
  `command_id` binary(16) DEFAULT NULL,
  `created_device_id` binary(16) DEFAULT NULL,
  `captured_offline` tinyint(1) NOT NULL DEFAULT '0',
  `clock_suspect` tinyint(1) NOT NULL DEFAULT '0',
  `backdated_reason` text COLLATE utf8mb4_0900_as_cs,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_fieldwork_geo_checkins_command` (`command_id`),
  KEY `ix_fieldwork_geo_checkins_user_occurred` (`user_id`,`occurred_at`),
  KEY `ix_fieldwork_geo_checkins_session` (`work_session_id`),
  KEY `fk_fieldwork_geo_checkins_zone` (`declared_zone_id`),
  KEY `fk_fieldwork_geo_checkins_created_device` (`created_device_id`),
  KEY `fk_fieldwork_geo_checkins_created_by` (`created_by`),
  CONSTRAINT `fk_fieldwork_geo_checkins_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_fieldwork_geo_checkins_created_device` FOREIGN KEY (`created_device_id`) REFERENCES `identity_devices` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_fieldwork_geo_checkins_session` FOREIGN KEY (`work_session_id`) REFERENCES `fieldwork_work_sessions` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_fieldwork_geo_checkins_user` FOREIGN KEY (`user_id`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_fieldwork_geo_checkins_zone` FOREIGN KEY (`declared_zone_id`) REFERENCES `organization_zones` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_fieldwork_geo_checkins_client_result` CHECK ((`client_result` in (_utf8mb4'ACCEPTED',_utf8mb4'REJECTED_OUT_OF_ZONE',_utf8mb4'REJECTED_LOW_ACCURACY',_utf8mb4'NO_POSITION'))),
  CONSTRAINT `ck_fieldwork_geo_checkins_no_position` CHECK (((`server_result` <> _utf8mb4'NO_POSITION') or (`lat` is null))),
  CONSTRAINT `ck_fieldwork_geo_checkins_position` CHECK ((((`lat` is null) and (`lng` is null)) or ((`lat` is not null) and (`lng` is not null)))),
  CONSTRAINT `ck_fieldwork_geo_checkins_ranges` CHECK ((((`lat` is null) or (`lat` between -(90) and 90)) and ((`lng` is null) or (`lng` between -(180) and 180)) and ((`accuracy_m` is null) or (`accuracy_m` >= 0)))),
  CONSTRAINT `ck_fieldwork_geo_checkins_server_result` CHECK ((`server_result` in (_utf8mb4'ACCEPTED',_utf8mb4'REJECTED_OUT_OF_ZONE',_utf8mb4'REJECTED_LOW_ACCURACY',_utf8mb4'NO_POSITION',_utf8mb4'ZONE_INACTIVE'))),
  CONSTRAINT `ck_fieldwork_geo_checkins_type` CHECK ((`checkin_type` in (_utf8mb4'START_SERVICE',_utf8mb4'END_SERVICE')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_fieldwork_geo_checkins_no_update` BEFORE UPDATE ON `fieldwork_geo_checkins` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'fieldwork_geo_checkins : tentative de pointage immuable (INV-TER-02).';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_fieldwork_geo_checkins_no_delete` BEFORE DELETE ON `fieldwork_geo_checkins` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'fieldwork_geo_checkins : suppression physique interdite (INV-TER-02, INV-GLO-03).';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `fieldwork_work_sessions`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `fieldwork_work_sessions` (
  `id` binary(16) NOT NULL,
  `user_id` binary(16) NOT NULL,
  `device_id` binary(16) NOT NULL,
  `declared_zone_id` binary(16) NOT NULL,
  `started_at` datetime(6) NOT NULL,
  `start_checkin_id` binary(16) NOT NULL,
  `ended_at` datetime(6) DEFAULT NULL,
  `end_checkin_id` binary(16) DEFAULT NULL,
  `status` varchar(12) COLLATE utf8mb4_0900_as_cs NOT NULL DEFAULT 'OPEN',
  `close_cause` varchar(12) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `override_status` varchar(12) COLLATE utf8mb4_0900_as_cs NOT NULL DEFAULT 'NOT_REQUIRED',
  `override_reason` text COLLATE utf8mb4_0900_as_cs,
  `approval_request_id` binary(16) DEFAULT NULL,
  `open_user_key` binary(16) GENERATED ALWAYS AS ((case when (`status` = _utf8mb4'OPEN') then `user_id` end)) STORED,
  `occurred_at` datetime(6) NOT NULL,
  `client_created_at` datetime(6) DEFAULT NULL,
  `received_at_server` datetime(6) DEFAULT NULL,
  `command_id` binary(16) DEFAULT NULL,
  `created_device_id` binary(16) DEFAULT NULL,
  `captured_offline` tinyint(1) NOT NULL DEFAULT '0',
  `clock_suspect` tinyint(1) NOT NULL DEFAULT '0',
  `backdated_reason` text COLLATE utf8mb4_0900_as_cs,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `updated_by` binary(16) DEFAULT NULL,
  `version` int NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_fieldwork_work_sessions_open_user` (`open_user_key`),
  UNIQUE KEY `uq_fieldwork_work_sessions_command` (`command_id`),
  KEY `ix_fieldwork_work_sessions_user_started` (`user_id`,`started_at`),
  KEY `fk_fieldwork_work_sessions_device` (`device_id`),
  KEY `fk_fieldwork_work_sessions_zone` (`declared_zone_id`),
  KEY `fk_fieldwork_work_sessions_approval` (`approval_request_id`),
  KEY `fk_fieldwork_work_sessions_created_device` (`created_device_id`),
  KEY `fk_fieldwork_work_sessions_created_by` (`created_by`),
  KEY `fk_fieldwork_work_sessions_updated_by` (`updated_by`),
  CONSTRAINT `fk_fieldwork_work_sessions_approval` FOREIGN KEY (`approval_request_id`) REFERENCES `approvals_approval_requests` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_fieldwork_work_sessions_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_fieldwork_work_sessions_created_device` FOREIGN KEY (`created_device_id`) REFERENCES `identity_devices` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_fieldwork_work_sessions_device` FOREIGN KEY (`device_id`) REFERENCES `identity_devices` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_fieldwork_work_sessions_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_fieldwork_work_sessions_user` FOREIGN KEY (`user_id`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_fieldwork_work_sessions_zone` FOREIGN KEY (`declared_zone_id`) REFERENCES `organization_zones` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_fieldwork_work_sessions_close_cause` CHECK (((`close_cause` is null) or (`close_cause` in (_utf8mb4'END_SERVICE',_utf8mb4'SUPERSEDED',_utf8mb4'AUTO_2359',_utf8mb4'FORCED')))),
  CONSTRAINT `ck_fieldwork_work_sessions_lifecycle` CHECK ((((`status` = _utf8mb4'OPEN') and (`ended_at` is null) and (`close_cause` is null) and (`end_checkin_id` is null)) or ((`status` <> _utf8mb4'OPEN') and (`ended_at` is not null) and (`close_cause` is not null)))),
  CONSTRAINT `ck_fieldwork_work_sessions_override` CHECK ((`override_status` in (_utf8mb4'NOT_REQUIRED',_utf8mb4'PENDING',_utf8mb4'APPROVED',_utf8mb4'REJECTED'))),
  CONSTRAINT `ck_fieldwork_work_sessions_period` CHECK (((`ended_at` is null) or (`ended_at` >= `started_at`))),
  CONSTRAINT `ck_fieldwork_work_sessions_status` CHECK ((`status` in (_utf8mb4'OPEN',_utf8mb4'CLOSED',_utf8mb4'AUTO_CLOSED')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_fieldwork_work_sessions_update_guard` BEFORE UPDATE ON `fieldwork_work_sessions` FOR EACH ROW BEGIN
  IF NOT (
    NEW.user_id <=> OLD.user_id AND
    NEW.device_id <=> OLD.device_id AND
    NEW.declared_zone_id <=> OLD.declared_zone_id AND
    NEW.started_at <=> OLD.started_at AND
    NEW.start_checkin_id <=> OLD.start_checkin_id AND
    NEW.occurred_at <=> OLD.occurred_at AND
    NEW.command_id <=> OLD.command_id AND
    NEW.created_device_id <=> OLD.created_device_id AND
    NEW.created_at <=> OLD.created_at AND
    NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'fieldwork_work_sessions : seules la clôture et la dérogation sont modifiables.';
  END IF;
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_fieldwork_work_sessions_no_delete` BEFORE DELETE ON `fieldwork_work_sessions` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'fieldwork_work_sessions : suppression physique interdite (INV-GLO-03).';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `finance_cash_accounts`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `finance_cash_accounts` (
  `id` binary(16) NOT NULL,
  `code` varchar(40) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `name` varchar(200) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `account_type` varchar(20) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `site_id` binary(16) DEFAULT NULL,
  `holder_user_id` binary(16) DEFAULT NULL,
  `responsible_user_id` binary(16) NOT NULL,
  `external_ref` varchar(60) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `balance_xaf` bigint NOT NULL DEFAULT '0',
  `status` varchar(20) COLLATE utf8mb4_0900_as_cs NOT NULL DEFAULT 'ACTIVE',
  `active_pos_site` binary(16) GENERATED ALWAYS AS (if(((`account_type` = _utf8mb4'CAISSE_PDV') and (`status` = _utf8mb4'ACTIVE')),`site_id`,NULL)) STORED,
  `active_user_holder` binary(16) GENERATED ALWAYS AS (if(((`account_type` = _utf8mb4'CAISSE_UTILISATEUR') and (`status` = _utf8mb4'ACTIVE')),`holder_user_id`,NULL)) STORED,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `updated_by` binary(16) DEFAULT NULL,
  `version` int NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_finance_cash_accounts_code` (`code`),
  UNIQUE KEY `uq_finance_cash_accounts_active_pos_site` (`active_pos_site`),
  UNIQUE KEY `uq_finance_cash_accounts_active_user_holder` (`active_user_holder`),
  KEY `ix_finance_cash_accounts_site` (`site_id`,`account_type`),
  KEY `ix_finance_cash_accounts_holder` (`holder_user_id`),
  KEY `fk_finance_cash_accounts_responsible` (`responsible_user_id`),
  KEY `fk_finance_cash_accounts_created_by` (`created_by`),
  KEY `fk_finance_cash_accounts_updated_by` (`updated_by`),
  CONSTRAINT `fk_finance_cash_accounts_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_finance_cash_accounts_holder` FOREIGN KEY (`holder_user_id`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_finance_cash_accounts_responsible` FOREIGN KEY (`responsible_user_id`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_finance_cash_accounts_site` FOREIGN KEY (`site_id`) REFERENCES `organization_sites` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_finance_cash_accounts_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_finance_cash_accounts_pos_site` CHECK (((`account_type` <> _utf8mb4'CAISSE_PDV') or (`site_id` is not null))),
  CONSTRAINT `ck_finance_cash_accounts_status` CHECK ((`status` in (_utf8mb4'ACTIVE',_utf8mb4'INACTIVE'))),
  CONSTRAINT `ck_finance_cash_accounts_type` CHECK ((`account_type` in (_utf8mb4'CAISSE_PDV',_utf8mb4'CAISSE_UTILISATEUR',_utf8mb4'CAISSE_CENTRALE',_utf8mb4'MOBILE_MONEY',_utf8mb4'BANQUE'))),
  CONSTRAINT `ck_finance_cash_accounts_user_holder` CHECK (((`account_type` <> _utf8mb4'CAISSE_UTILISATEUR') or (`holder_user_id` is not null)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_finance_cash_accounts_no_delete` BEFORE DELETE ON `finance_cash_accounts` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'finance_cash_accounts : suppression interdite (INV-FIN-01) ; désactiver le compte.';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `finance_cash_movements`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `finance_cash_movements` (
  `id` binary(16) NOT NULL,
  `cash_account_id` binary(16) NOT NULL,
  `direction` varchar(3) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `amount_xaf` bigint NOT NULL,
  `movement_type` varchar(25) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `source_doc_type` varchar(25) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `source_doc_id` binary(16) NOT NULL,
  `cash_session_id` binary(16) DEFAULT NULL,
  `occurred_at` datetime(6) NOT NULL,
  `business_date` date GENERATED ALWAYS AS (cast(convert_tz(`occurred_at`,_utf8mb4'+00:00',_utf8mb4'+01:00') as date)) STORED,
  `recorded_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `is_reversal` tinyint(1) NOT NULL DEFAULT '0',
  `reverses_movement_id` binary(16) DEFAULT NULL,
  `command_id` binary(16) DEFAULT NULL,
  `created_device_id` binary(16) DEFAULT NULL,
  `captured_offline` tinyint(1) NOT NULL DEFAULT '0',
  `created_by` binary(16) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_finance_cash_movements_reverses` (`reverses_movement_id`),
  KEY `ix_finance_cash_movements_account` (`cash_account_id`,`occurred_at`),
  KEY `ix_finance_cash_movements_source` (`source_doc_type`,`source_doc_id`),
  KEY `ix_finance_cash_movements_session` (`cash_session_id`),
  KEY `ix_finance_cash_movements_business_date` (`business_date`,`cash_account_id`),
  KEY `fk_finance_cash_movements_created_device` (`created_device_id`),
  KEY `fk_finance_cash_movements_created_by` (`created_by`),
  CONSTRAINT `fk_finance_cash_movements_account` FOREIGN KEY (`cash_account_id`) REFERENCES `finance_cash_accounts` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_finance_cash_movements_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_finance_cash_movements_created_device` FOREIGN KEY (`created_device_id`) REFERENCES `identity_devices` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_finance_cash_movements_reverses` FOREIGN KEY (`reverses_movement_id`) REFERENCES `finance_cash_movements` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_finance_cash_movements_amount` CHECK ((`amount_xaf` > 0)),
  CONSTRAINT `ck_finance_cash_movements_direction` CHECK ((`direction` in (_utf8mb4'IN',_utf8mb4'OUT'))),
  CONSTRAINT `ck_finance_cash_movements_reversal` CHECK ((((`is_reversal` = false) and (`reverses_movement_id` is null)) or ((`is_reversal` = true) and (`reverses_movement_id` is not null)))),
  CONSTRAINT `ck_finance_cash_movements_source_doc_type` CHECK ((`source_doc_type` in (_utf8mb4'CUSTOMER_PAYMENT',_utf8mb4'SALE_REFUND',_utf8mb4'SUPPLIER_PAYMENT',_utf8mb4'EXPENSE',_utf8mb4'CASH_TRANSFER',_utf8mb4'CASH_SESSION'))),
  CONSTRAINT `ck_finance_cash_movements_type` CHECK ((`movement_type` in (_utf8mb4'CUSTOMER_PAYMENT',_utf8mb4'REFUND',_utf8mb4'SUPPLIER_PAYMENT',_utf8mb4'EXPENSE',_utf8mb4'TRANSFER_OUT',_utf8mb4'TRANSFER_IN',_utf8mb4'SESSION_VARIANCE',_utf8mb4'OPENING_BALANCE')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_finance_cash_movements_no_update` BEFORE UPDATE ON `finance_cash_movements` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'finance_cash_movements : registre immuable (BR-FIN-011) ; corriger par un mouvement inverse.';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_finance_cash_movements_no_delete` BEFORE DELETE ON `finance_cash_movements` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'finance_cash_movements : suppression interdite (INV-FIN-01).';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `finance_payment_methods`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `finance_payment_methods` (
  `code` varchar(40) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `label` varchar(100) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `requires_reference` tinyint(1) NOT NULL DEFAULT '0',
  `default_account_type` varchar(20) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `version` int NOT NULL DEFAULT '1',
  PRIMARY KEY (`code`),
  CONSTRAINT `ck_finance_payment_methods_account_type` CHECK ((`default_account_type` in (_utf8mb4'CAISSE_PDV',_utf8mb4'CAISSE_UTILISATEUR',_utf8mb4'CAISSE_CENTRALE',_utf8mb4'MOBILE_MONEY',_utf8mb4'BANQUE')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_finance_payment_methods_no_delete` BEFORE DELETE ON `finance_payment_methods` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'finance_payment_methods : suppression interdite ; désactiver le moyen.';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `identity_auth_sessions`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `identity_auth_sessions` (
  `id` binary(16) NOT NULL,
  `user_id` binary(16) NOT NULL,
  `device_id` binary(16) NOT NULL,
  `refresh_token_hash` char(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `token_family_id` binary(16) NOT NULL,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `last_used_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `expires_at` datetime(6) NOT NULL,
  `offline_grant_until` datetime(6) NOT NULL,
  `revoked_at` datetime(6) DEFAULT NULL,
  `revoked_reason` varchar(20) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `ip_first` varchar(45) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `ip_last` varchar(45) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_identity_auth_sessions_refresh_token_hash` (`refresh_token_hash`),
  KEY `ix_identity_auth_sessions_user_device` (`user_id`,`device_id`),
  KEY `ix_identity_auth_sessions_expires_at` (`expires_at`),
  KEY `fk_identity_auth_sessions_device` (`device_id`),
  CONSTRAINT `fk_identity_auth_sessions_device` FOREIGN KEY (`device_id`) REFERENCES `identity_devices` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_identity_auth_sessions_user` FOREIGN KEY (`user_id`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_identity_auth_sessions_revoked_reason` CHECK (((`revoked_reason` is null) or (`revoked_reason` in (_utf8mb4'LOGOUT',_utf8mb4'ADMIN',_utf8mb4'USER_DEACTIVATED',_utf8mb4'DEVICE_BLOCKED',_utf8mb4'TOKEN_REUSE',_utf8mb4'EXPIRED',_utf8mb4'ROTATED'))))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `identity_devices`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `identity_devices` (
  `id` binary(16) NOT NULL,
  `short_code` varchar(4) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `label` varchar(200) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `enrolled_by_user_id` binary(16) NOT NULL,
  `status` varchar(20) COLLATE utf8mb4_0900_as_cs NOT NULL DEFAULT 'PENDING',
  `status_changed_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `status_reason` text COLLATE utf8mb4_0900_as_cs,
  `approved_by` binary(16) DEFAULT NULL,
  `platform` varchar(100) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `app_version` varchar(20) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `is_shared` tinyint(1) NOT NULL DEFAULT '0',
  `designated_site_id` binary(16) DEFAULT NULL,
  `last_seen_at` datetime(6) DEFAULT NULL,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `updated_by` binary(16) DEFAULT NULL,
  `version` int NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_identity_devices_short_code` (`short_code`),
  KEY `ix_identity_devices_status` (`status`),
  KEY `ix_identity_devices_enrolled_by` (`enrolled_by_user_id`),
  KEY `fk_identity_devices_approved_by` (`approved_by`),
  KEY `fk_identity_devices_created_by` (`created_by`),
  KEY `fk_identity_devices_updated_by` (`updated_by`),
  KEY `fk_identity_devices_designated_site` (`designated_site_id`),
  CONSTRAINT `fk_identity_devices_approved_by` FOREIGN KEY (`approved_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_identity_devices_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_identity_devices_designated_site` FOREIGN KEY (`designated_site_id`) REFERENCES `organization_sites` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_identity_devices_enrolled_by` FOREIGN KEY (`enrolled_by_user_id`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_identity_devices_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_identity_devices_approved_by` CHECK (((`status` <> _utf8mb4'ACTIVE') or (`approved_by` is not null))),
  CONSTRAINT `ck_identity_devices_status` CHECK ((`status` in (_utf8mb4'PENDING',_utf8mb4'ACTIVE',_utf8mb4'BLOCKED',_utf8mb4'LOST',_utf8mb4'RETIRED')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_identity_devices_no_delete` BEFORE DELETE ON `identity_devices` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'identity_devices : suppression physique interdite (INV-GLO-03) ; utiliser RETIRED.';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `identity_login_attempts`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `identity_login_attempts` (
  `scope_type` varchar(10) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `scope_value` varchar(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `failed_count` smallint NOT NULL DEFAULT '0',
  `blocked_until` datetime(6) DEFAULT NULL,
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`scope_type`,`scope_value`),
  CONSTRAINT `ck_identity_login_attempts_scope_type` CHECK ((`scope_type` in (_utf8mb4'IDENTIFIER',_utf8mb4'IP')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `identity_permissions`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `identity_permissions` (
  `code` varchar(80) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `module` varchar(40) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `description` text COLLATE utf8mb4_0900_as_cs NOT NULL,
  `supported_scopes` json NOT NULL,
  `is_approval` tinyint(1) NOT NULL DEFAULT '0',
  `is_sensitive` tinyint(1) NOT NULL DEFAULT '0',
  `deprecated_at` datetime(6) DEFAULT NULL,
  PRIMARY KEY (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_identity_permissions_no_delete` BEFORE DELETE ON `identity_permissions` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'identity_permissions : suppression physique interdite ; utiliser deprecated_at.';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `identity_role_permissions`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `identity_role_permissions` (
  `role_id` binary(16) NOT NULL,
  `permission_code` varchar(80) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `max_scope` varchar(10) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `limits` json DEFAULT NULL,
  `granted_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `granted_by` binary(16) NOT NULL,
  PRIMARY KEY (`role_id`,`permission_code`),
  KEY `fk_identity_role_permissions_permission` (`permission_code`),
  KEY `fk_identity_role_permissions_granted_by` (`granted_by`),
  CONSTRAINT `fk_identity_role_permissions_granted_by` FOREIGN KEY (`granted_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_identity_role_permissions_permission` FOREIGN KEY (`permission_code`) REFERENCES `identity_permissions` (`code`) ON DELETE RESTRICT,
  CONSTRAINT `fk_identity_role_permissions_role` FOREIGN KEY (`role_id`) REFERENCES `identity_roles` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_identity_role_permissions_max_scope` CHECK ((`max_scope` in (_utf8mb4'OWN',_utf8mb4'TEAM',_utf8mb4'SITE',_utf8mb4'ZONE',_utf8mb4'ALL')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `identity_roles`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `identity_roles` (
  `id` binary(16) NOT NULL,
  `code` varchar(40) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `name` varchar(200) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `description` text COLLATE utf8mb4_0900_as_cs,
  `allowed_scope_types` json NOT NULL DEFAULT (json_array(_utf8mb4'GLOBAL')),
  `is_system` tinyint(1) NOT NULL DEFAULT '0',
  `is_active` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `updated_by` binary(16) DEFAULT NULL,
  `version` int NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_identity_roles_code` (`code`),
  KEY `fk_identity_roles_created_by` (`created_by`),
  KEY `fk_identity_roles_updated_by` (`updated_by`),
  CONSTRAINT `fk_identity_roles_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_identity_roles_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_identity_roles_code` CHECK (regexp_like(`code`,_utf8mb4'^[A-Z][A-Z0-9_]*$'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_identity_roles_no_delete` BEFORE DELETE ON `identity_roles` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'identity_roles : suppression physique interdite (INV-GLO-03) ; utiliser is_active=false.';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `identity_user_role_assignments`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `identity_user_role_assignments` (
  `id` binary(16) NOT NULL,
  `user_id` binary(16) NOT NULL,
  `role_id` binary(16) NOT NULL,
  `scope_type` varchar(10) COLLATE utf8mb4_0900_as_cs NOT NULL DEFAULT 'GLOBAL',
  `scope_site_id` binary(16) DEFAULT NULL,
  `scope_zone_id` binary(16) DEFAULT NULL,
  `scope_team_id` binary(16) DEFAULT NULL,
  `valid_from` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `valid_to` datetime(6) DEFAULT NULL,
  `revoked_at` datetime(6) DEFAULT NULL,
  `revoked_by` binary(16) DEFAULT NULL,
  `revoke_reason` text COLLATE utf8mb4_0900_as_cs,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `updated_by` binary(16) DEFAULT NULL,
  `version` int NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`),
  KEY `ix_identity_user_role_assignments_user` (`user_id`,`valid_from`,`valid_to`),
  KEY `ix_identity_user_role_assignments_role` (`role_id`),
  KEY `fk_identity_ura_scope_site` (`scope_site_id`),
  KEY `fk_identity_ura_scope_zone` (`scope_zone_id`),
  KEY `fk_identity_ura_scope_team` (`scope_team_id`),
  KEY `fk_identity_ura_revoked_by` (`revoked_by`),
  KEY `fk_identity_ura_created_by` (`created_by`),
  KEY `fk_identity_ura_updated_by` (`updated_by`),
  CONSTRAINT `fk_identity_ura_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_identity_ura_revoked_by` FOREIGN KEY (`revoked_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_identity_ura_role` FOREIGN KEY (`role_id`) REFERENCES `identity_roles` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_identity_ura_scope_site` FOREIGN KEY (`scope_site_id`) REFERENCES `organization_sites` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_identity_ura_scope_team` FOREIGN KEY (`scope_team_id`) REFERENCES `organization_teams` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_identity_ura_scope_zone` FOREIGN KEY (`scope_zone_id`) REFERENCES `organization_zones` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_identity_ura_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_identity_ura_user` FOREIGN KEY (`user_id`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_identity_user_role_assignments_period` CHECK (((`valid_to` is null) or (`valid_to` > `valid_from`))),
  CONSTRAINT `ck_identity_user_role_assignments_scope_cols` CHECK ((((`scope_type` = _utf8mb4'GLOBAL') and (`scope_site_id` is null) and (`scope_zone_id` is null) and (`scope_team_id` is null)) or ((`scope_type` = _utf8mb4'SITE') and (`scope_site_id` is not null) and (`scope_zone_id` is null) and (`scope_team_id` is null)) or ((`scope_type` = _utf8mb4'ZONE') and (`scope_zone_id` is not null) and (`scope_site_id` is null) and (`scope_team_id` is null)) or ((`scope_type` = _utf8mb4'TEAM') and (`scope_team_id` is not null) and (`scope_site_id` is null) and (`scope_zone_id` is null)))),
  CONSTRAINT `ck_identity_user_role_assignments_scope_type` CHECK ((`scope_type` in (_utf8mb4'GLOBAL',_utf8mb4'SITE',_utf8mb4'ZONE',_utf8mb4'TEAM')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_identity_ura_scope_allowed` BEFORE INSERT ON `identity_user_role_assignments` FOR EACH ROW BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM identity_roles
    WHERE id = NEW.role_id AND JSON_CONTAINS(allowed_scope_types, JSON_QUOTE(NEW.scope_type))
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'identity_user_role_assignments : scope_type non autorisé pour ce rôle (roles.allowed_scope_types).';
  END IF;
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_identity_ura_update_guard` BEFORE UPDATE ON `identity_user_role_assignments` FOR EACH ROW BEGIN
  IF NOT (
    NEW.user_id <=> OLD.user_id AND
    NEW.role_id <=> OLD.role_id AND
    NEW.scope_type <=> OLD.scope_type AND
    NEW.scope_site_id <=> OLD.scope_site_id AND
    NEW.scope_zone_id <=> OLD.scope_zone_id AND
    NEW.scope_team_id <=> OLD.scope_team_id AND
    NEW.valid_from <=> OLD.valid_from AND
    NEW.created_at <=> OLD.created_at AND
    NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'identity_user_role_assignments : seule la révocation/fermeture est modifiable (INV-ADM-04).';
  END IF;
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_identity_ura_no_delete` BEFORE DELETE ON `identity_user_role_assignments` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'identity_user_role_assignments : suppression physique interdite (INV-ADM-04) ; révoquer.';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `identity_users`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `identity_users` (
  `id` binary(16) NOT NULL,
  `full_name` varchar(200) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `phone` varchar(20) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `email` varchar(200) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `password_hash` text COLLATE utf8mb4_0900_as_cs NOT NULL,
  `must_change_password` tinyint(1) NOT NULL DEFAULT '1',
  `status` varchar(20) COLLATE utf8mb4_0900_as_cs NOT NULL DEFAULT 'ACTIVE',
  `status_changed_at` datetime(6) DEFAULT NULL,
  `status_reason` text COLLATE utf8mb4_0900_as_cs,
  `primary_device_id` binary(16) DEFAULT NULL,
  `locale` varchar(10) COLLATE utf8mb4_0900_as_cs NOT NULL DEFAULT 'fr-CM',
  `is_system` tinyint(1) NOT NULL DEFAULT '0',
  `last_login_at` datetime(6) DEFAULT NULL,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `updated_by` binary(16) DEFAULT NULL,
  `version` int NOT NULL DEFAULT '1',
  `active_phone` varchar(20) COLLATE utf8mb4_0900_as_cs GENERATED ALWAYS AS (if((`status` <> _utf8mb4'DEACTIVATED'),`phone`,NULL)) STORED,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_identity_users_active_phone` (`active_phone`),
  KEY `ix_identity_users_status` (`status`),
  KEY `fk_identity_users_created_by` (`created_by`),
  KEY `fk_identity_users_updated_by` (`updated_by`),
  KEY `fk_identity_users_primary_device` (`primary_device_id`),
  CONSTRAINT `fk_identity_users_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_identity_users_primary_device` FOREIGN KEY (`primary_device_id`) REFERENCES `identity_devices` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_identity_users_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_identity_users_phone` CHECK (regexp_like(`phone`,_utf8mb4'^\\+[1-9][0-9]{7,14}$')),
  CONSTRAINT `ck_identity_users_status` CHECK ((`status` in (_utf8mb4'ACTIVE',_utf8mb4'SUSPENDED',_utf8mb4'DEACTIVATED'))),
  CONSTRAINT `ck_identity_users_status_reason` CHECK (((`status` = _utf8mb4'ACTIVE') or (`status_reason` is not null)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_identity_users_no_delete` BEFORE DELETE ON `identity_users` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'identity_users : suppression physique interdite (INV-GLO-03) ; utiliser DEACTIVATED.';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `inventory_consumptions`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `inventory_consumptions` (
  `id` binary(16) NOT NULL,
  `location_id` binary(16) NOT NULL,
  `product_id` binary(16) NOT NULL,
  `lot_id` binary(16) DEFAULT NULL,
  `quantity_base` decimal(14,3) NOT NULL,
  `unit_code` varchar(20) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `quantity` decimal(14,3) NOT NULL,
  `cost_object_type` varchar(20) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `cost_object_id` binary(16) NOT NULL,
  `cost_type` varchar(25) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `recorded_by` binary(16) NOT NULL,
  `value_xaf` bigint NOT NULL,
  `status` varchar(10) COLLATE utf8mb4_0900_as_cs NOT NULL DEFAULT 'RECORDED',
  `cancelled_at` datetime(6) DEFAULT NULL,
  `cancelled_by` binary(16) DEFAULT NULL,
  `cancel_reason_code_id` binary(16) DEFAULT NULL,
  `cancel_comment` text COLLATE utf8mb4_0900_as_cs,
  `cancel_approval_request_id` binary(16) DEFAULT NULL,
  `occurred_at` datetime(6) NOT NULL,
  `client_created_at` datetime(6) DEFAULT NULL,
  `received_at_server` datetime(6) DEFAULT NULL,
  `command_id` binary(16) DEFAULT NULL,
  `created_device_id` binary(16) DEFAULT NULL,
  `captured_offline` tinyint(1) NOT NULL DEFAULT '0',
  `clock_suspect` tinyint(1) NOT NULL DEFAULT '0',
  `backdated_reason` text COLLATE utf8mb4_0900_as_cs,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `updated_by` binary(16) DEFAULT NULL,
  `version` int NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_inventory_consumptions_command` (`command_id`),
  KEY `ix_inventory_consumptions_cost_object` (`cost_object_type`,`cost_object_id`,`occurred_at`),
  KEY `fk_inventory_consumptions_location` (`location_id`),
  KEY `fk_inventory_consumptions_product` (`product_id`),
  KEY `fk_inventory_consumptions_lot` (`lot_id`),
  KEY `fk_inventory_consumptions_unit` (`unit_code`),
  KEY `fk_inventory_consumptions_recorded_by` (`recorded_by`),
  KEY `fk_inventory_consumptions_cancelled_by` (`cancelled_by`),
  KEY `fk_inventory_consumptions_cancel_reason` (`cancel_reason_code_id`),
  KEY `fk_inventory_consumptions_cancel_approval` (`cancel_approval_request_id`),
  KEY `fk_inventory_consumptions_device` (`created_device_id`),
  KEY `fk_inventory_consumptions_created_by` (`created_by`),
  KEY `fk_inventory_consumptions_updated_by` (`updated_by`),
  CONSTRAINT `fk_inventory_consumptions_cancel_approval` FOREIGN KEY (`cancel_approval_request_id`) REFERENCES `approvals_approval_requests` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_consumptions_cancel_reason` FOREIGN KEY (`cancel_reason_code_id`) REFERENCES `catalog_reason_codes` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_consumptions_cancelled_by` FOREIGN KEY (`cancelled_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_consumptions_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_consumptions_device` FOREIGN KEY (`created_device_id`) REFERENCES `identity_devices` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_consumptions_location` FOREIGN KEY (`location_id`) REFERENCES `organization_locations` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_consumptions_lot` FOREIGN KEY (`lot_id`) REFERENCES `inventory_stock_lots` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_consumptions_product` FOREIGN KEY (`product_id`) REFERENCES `catalog_products` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_consumptions_recorded_by` FOREIGN KEY (`recorded_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_consumptions_unit` FOREIGN KEY (`unit_code`) REFERENCES `catalog_units` (`code`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_consumptions_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_inventory_consumptions_cost_object` CHECK ((`cost_object_type` in (_utf8mb4'PRODUCTION_LOT',_utf8mb4'INCUBATION_BATCH',_utf8mb4'SITE'))),
  CONSTRAINT `ck_inventory_consumptions_cost_type` CHECK (((`cost_type` is null) or (`cost_type` in (_utf8mb4'ANIMAUX',_utf8mb4'OEUFS',_utf8mb4'ALIMENT',_utf8mb4'VETERINAIRE',_utf8mb4'AUTRE_INTRANT',_utf8mb4'DEPENSE_DIRECTE',_utf8mb4'AJUSTEMENT')))),
  CONSTRAINT `ck_inventory_consumptions_qty` CHECK (((`quantity_base` > 0) and (`quantity` > 0))),
  CONSTRAINT `ck_inventory_consumptions_status` CHECK ((`status` in (_utf8mb4'RECORDED',_utf8mb4'CANCELLED')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_inventory_consumptions_no_delete` BEFORE DELETE ON `inventory_consumptions` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_consumptions : suppression physique interdite (INV-GLO-03) ; utiliser CANCELLED.';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `inventory_cost_entries`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `inventory_cost_entries` (
  `id` binary(16) NOT NULL,
  `cost_object_type` varchar(20) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `cost_object_id` binary(16) NOT NULL,
  `cost_type` varchar(25) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `species_group` varchar(10) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `amount_xaf` bigint NOT NULL,
  `direction` varchar(10) COLLATE utf8mb4_0900_as_cs NOT NULL DEFAULT 'DEBIT',
  `source_type` varchar(20) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `source_id` binary(16) NOT NULL,
  `reverses_entry_id` binary(16) DEFAULT NULL,
  `occurred_at` datetime(6) NOT NULL,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  `comment` text COLLATE utf8mb4_0900_as_cs,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_inventory_cost_entries_source` (`source_type`,`source_id`,`cost_object_id`),
  UNIQUE KEY `uq_inventory_cost_entries_reverses` (`reverses_entry_id`),
  KEY `ix_inventory_cost_entries_object` (`cost_object_type`,`cost_object_id`,`occurred_at`),
  KEY `fk_inventory_cost_entries_created_by` (`created_by`),
  CONSTRAINT `fk_inventory_cost_entries_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_cost_entries_reverses` FOREIGN KEY (`reverses_entry_id`) REFERENCES `inventory_cost_entries` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_inventory_cost_entries_amount` CHECK ((`amount_xaf` > 0)),
  CONSTRAINT `ck_inventory_cost_entries_cost_object` CHECK ((`cost_object_type` in (_utf8mb4'PRODUCTION_LOT',_utf8mb4'INCUBATION_BATCH',_utf8mb4'SITE'))),
  CONSTRAINT `ck_inventory_cost_entries_cost_type` CHECK ((`cost_type` in (_utf8mb4'ANIMAUX',_utf8mb4'OEUFS',_utf8mb4'ALIMENT',_utf8mb4'VETERINAIRE',_utf8mb4'AUTRE_INTRANT',_utf8mb4'DEPENSE_DIRECTE',_utf8mb4'AJUSTEMENT',_utf8mb4'FRAIS_GENERAUX',_utf8mb4'PRODUCTION_TRANSFEREE'))),
  CONSTRAINT `ck_inventory_cost_entries_direction` CHECK ((`direction` in (_utf8mb4'DEBIT',_utf8mb4'CREDIT'))),
  CONSTRAINT `ck_inventory_cost_entries_overhead_species` CHECK (((`cost_type` <> _utf8mb4'FRAIS_GENERAUX') or (`species_group` is not null))),
  CONSTRAINT `ck_inventory_cost_entries_source_type` CHECK ((`source_type` in (_utf8mb4'STOCK_MOVE',_utf8mb4'EXPENSE',_utf8mb4'MANUAL',_utf8mb4'OVERHEAD_ENTRY',_utf8mb4'ALLOCATION',_utf8mb4'PRODUCTION'))),
  CONSTRAINT `ck_inventory_cost_entries_species` CHECK (((`species_group` is null) or (`species_group` in (_utf8mb4'VOLAILLE',_utf8mb4'PORC'))))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_inventory_cost_entries_no_update` BEFORE UPDATE ON `inventory_cost_entries` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_cost_entries : registre immuable ; créer une écriture inverse.';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_inventory_cost_entries_no_delete` BEFORE DELETE ON `inventory_cost_entries` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_cost_entries : suppression physique interdite.';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `inventory_inventory_count_lines`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `inventory_inventory_count_lines` (
  `id` binary(16) NOT NULL,
  `count_id` binary(16) NOT NULL,
  `product_id` binary(16) NOT NULL,
  `lot_id` binary(16) DEFAULT NULL,
  `lot_key` binary(16) GENERATED ALWAYS AS (coalesce(`lot_id`,0x00000000000000000000000000000000)) STORED,
  `counted_at` datetime(6) NOT NULL,
  `counted_qty_base` decimal(14,3) NOT NULL,
  `theoretical_qty_base` decimal(14,3) DEFAULT NULL,
  `variance_qty_base` decimal(14,3) DEFAULT NULL,
  `reconciled_adjustment_qty_base` decimal(14,3) NOT NULL DEFAULT '0.000',
  `unit_cost_xaf` bigint DEFAULT NULL,
  `variance_reason_code_id` binary(16) DEFAULT NULL,
  `declared_unit_cost_xaf` bigint DEFAULT NULL,
  `comment` text COLLATE utf8mb4_0900_as_cs,
  `command_id` binary(16) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_inventory_inventory_count_lines_product_lot` (`count_id`,`product_id`,`lot_key`),
  KEY `fk_inventory_inventory_count_lines_product` (`product_id`),
  KEY `fk_inventory_inventory_count_lines_lot` (`lot_id`),
  KEY `fk_inventory_inventory_count_lines_reason` (`variance_reason_code_id`),
  CONSTRAINT `fk_inventory_inventory_count_lines_count` FOREIGN KEY (`count_id`) REFERENCES `inventory_inventory_counts` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_inventory_count_lines_lot` FOREIGN KEY (`lot_id`) REFERENCES `inventory_stock_lots` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_inventory_count_lines_product` FOREIGN KEY (`product_id`) REFERENCES `catalog_products` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_inventory_count_lines_reason` FOREIGN KEY (`variance_reason_code_id`) REFERENCES `catalog_reason_codes` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_inventory_inventory_count_lines_counted` CHECK ((`counted_qty_base` >= 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_inventory_inventory_count_lines_no_delete` BEFORE DELETE ON `inventory_inventory_count_lines` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_inventory_count_lines : suit l''inventaire, jamais supprimée indépendamment.';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `inventory_inventory_counts`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `inventory_inventory_counts` (
  `id` binary(16) NOT NULL,
  `doc_number` varchar(40) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `local_ref` varchar(20) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `site_id` binary(16) NOT NULL,
  `location_id` binary(16) NOT NULL,
  `count_type` varchar(10) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `status` varchar(20) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `opened_by` binary(16) DEFAULT NULL,
  `submitted_by` binary(16) DEFAULT NULL,
  `submitted_at` datetime(6) DEFAULT NULL,
  `variance_value_xaf` bigint DEFAULT NULL,
  `abs_variance_value_xaf` bigint DEFAULT NULL,
  `net_variance_after_reconciliation_xaf` bigint DEFAULT NULL,
  `approval_request_id` binary(16) DEFAULT NULL,
  `posted_at` datetime(6) DEFAULT NULL,
  `occurred_at` datetime(6) NOT NULL,
  `client_created_at` datetime(6) DEFAULT NULL,
  `received_at_server` datetime(6) DEFAULT NULL,
  `command_id` binary(16) DEFAULT NULL,
  `created_device_id` binary(16) DEFAULT NULL,
  `captured_offline` tinyint(1) NOT NULL DEFAULT '0',
  `clock_suspect` tinyint(1) NOT NULL DEFAULT '0',
  `backdated_reason` text COLLATE utf8mb4_0900_as_cs,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `updated_by` binary(16) DEFAULT NULL,
  `version` int NOT NULL DEFAULT '1',
  `in_progress_key` binary(16) GENERATED ALWAYS AS (if((`status` = _utf8mb4'IN_PROGRESS'),`location_id`,NULL)) STORED,
  `opening_posted_key` binary(16) GENERATED ALWAYS AS (if(((`count_type` = _utf8mb4'OPENING') and (`status` = _utf8mb4'POSTED')),`location_id`,NULL)) STORED,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_inventory_inventory_counts_doc_number` (`doc_number`),
  UNIQUE KEY `uq_inventory_inventory_counts_command` (`command_id`),
  UNIQUE KEY `uq_inventory_inventory_counts_device_ref` (`created_device_id`,`local_ref`),
  UNIQUE KEY `uq_inventory_inventory_counts_in_progress` (`in_progress_key`),
  UNIQUE KEY `uq_inventory_inventory_counts_opening_posted` (`opening_posted_key`),
  KEY `fk_inventory_inventory_counts_site` (`site_id`),
  KEY `fk_inventory_inventory_counts_location` (`location_id`),
  KEY `fk_inventory_inventory_counts_opened_by` (`opened_by`),
  KEY `fk_inventory_inventory_counts_submitted_by` (`submitted_by`),
  KEY `fk_inventory_inventory_counts_approval` (`approval_request_id`),
  KEY `fk_inventory_inventory_counts_created_by` (`created_by`),
  KEY `fk_inventory_inventory_counts_updated_by` (`updated_by`),
  CONSTRAINT `fk_inventory_inventory_counts_approval` FOREIGN KEY (`approval_request_id`) REFERENCES `approvals_approval_requests` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_inventory_counts_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_inventory_counts_device` FOREIGN KEY (`created_device_id`) REFERENCES `identity_devices` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_inventory_counts_location` FOREIGN KEY (`location_id`) REFERENCES `organization_locations` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_inventory_counts_opened_by` FOREIGN KEY (`opened_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_inventory_counts_site` FOREIGN KEY (`site_id`) REFERENCES `organization_sites` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_inventory_counts_submitted_by` FOREIGN KEY (`submitted_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_inventory_counts_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_inventory_inventory_counts_status` CHECK ((`status` in (_utf8mb4'IN_PROGRESS',_utf8mb4'SUBMITTED',_utf8mb4'PENDING_APPROVAL',_utf8mb4'POSTED',_utf8mb4'REJECTED',_utf8mb4'CANCELLED'))),
  CONSTRAINT `ck_inventory_inventory_counts_type` CHECK ((`count_type` in (_utf8mb4'FULL',_utf8mb4'PARTIAL',_utf8mb4'SPOT',_utf8mb4'OPENING')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_inventory_inventory_counts_no_delete` BEFORE DELETE ON `inventory_inventory_counts` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_inventory_counts : suppression physique interdite (INV-GLO-03) ; utiliser CANCELLED/REJECTED.';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `inventory_loss_declarations`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `inventory_loss_declarations` (
  `id` binary(16) NOT NULL,
  `doc_number` varchar(40) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `local_ref` varchar(20) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `site_id` binary(16) NOT NULL,
  `location_id` binary(16) NOT NULL,
  `product_id` binary(16) NOT NULL,
  `lot_id` binary(16) DEFAULT NULL,
  `production_lot_id` binary(16) DEFAULT NULL,
  `incubation_batch_id` binary(16) DEFAULT NULL,
  `quantity_base` decimal(14,3) NOT NULL,
  `unit_code` varchar(20) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `quantity` decimal(14,3) NOT NULL,
  `category` varchar(20) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `reason_code_id` binary(16) DEFAULT NULL,
  `comment` text COLLATE utf8mb4_0900_as_cs,
  `declared_by` binary(16) NOT NULL,
  `policy_id` binary(16) DEFAULT NULL,
  `policy_version` int DEFAULT NULL,
  `requires_photo` tinyint(1) NOT NULL DEFAULT '0',
  `requires_approval` tinyint(1) NOT NULL DEFAULT '0',
  `status` varchar(25) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `approval_request_id` binary(16) DEFAULT NULL,
  `unit_cost_xaf` bigint NOT NULL,
  `value_xaf` bigint NOT NULL,
  `responsibility_user_id` binary(16) DEFAULT NULL,
  `cancelled_at` datetime(6) DEFAULT NULL,
  `cancelled_by` binary(16) DEFAULT NULL,
  `cancel_reason_code_id` binary(16) DEFAULT NULL,
  `cancel_comment` text COLLATE utf8mb4_0900_as_cs,
  `cancel_approval_request_id` binary(16) DEFAULT NULL,
  `occurred_at` datetime(6) NOT NULL,
  `business_date` date GENERATED ALWAYS AS (cast(convert_tz(`occurred_at`,_utf8mb4'+00:00',_utf8mb4'+01:00') as date)) STORED,
  `client_created_at` datetime(6) DEFAULT NULL,
  `received_at_server` datetime(6) DEFAULT NULL,
  `command_id` binary(16) DEFAULT NULL,
  `created_device_id` binary(16) DEFAULT NULL,
  `captured_offline` tinyint(1) NOT NULL DEFAULT '0',
  `clock_suspect` tinyint(1) NOT NULL DEFAULT '0',
  `backdated_reason` text COLLATE utf8mb4_0900_as_cs,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `updated_by` binary(16) DEFAULT NULL,
  `version` int NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_inventory_loss_declarations_doc_number` (`doc_number`),
  UNIQUE KEY `uq_inventory_loss_declarations_command` (`command_id`),
  UNIQUE KEY `uq_inventory_loss_declarations_device_ref` (`created_device_id`,`local_ref`),
  KEY `ix_inventory_loss_declarations_location` (`location_id`,`occurred_at`),
  KEY `ix_inventory_loss_declarations_production_lot` (`production_lot_id`,`occurred_at`),
  KEY `ix_inventory_loss_declarations_category` (`category`,`business_date`),
  KEY `ix_inventory_loss_declarations_status` (`status`),
  KEY `fk_inventory_loss_declarations_site` (`site_id`),
  KEY `fk_inventory_loss_declarations_product` (`product_id`),
  KEY `fk_inventory_loss_declarations_lot` (`lot_id`),
  KEY `fk_inventory_loss_declarations_unit` (`unit_code`),
  KEY `fk_inventory_loss_declarations_reason` (`reason_code_id`),
  KEY `fk_inventory_loss_declarations_declared_by` (`declared_by`),
  KEY `fk_inventory_loss_declarations_policy` (`policy_id`),
  KEY `fk_inventory_loss_declarations_approval` (`approval_request_id`),
  KEY `fk_inventory_loss_declarations_responsibility` (`responsibility_user_id`),
  KEY `fk_inventory_loss_declarations_cancelled_by` (`cancelled_by`),
  KEY `fk_inventory_loss_declarations_cancel_reason` (`cancel_reason_code_id`),
  KEY `fk_inventory_loss_declarations_cancel_approval` (`cancel_approval_request_id`),
  KEY `fk_inventory_loss_declarations_created_by` (`created_by`),
  KEY `fk_inventory_loss_declarations_updated_by` (`updated_by`),
  KEY `ix_inventory_loss_declarations_incubation_batch` (`incubation_batch_id`,`occurred_at`),
  CONSTRAINT `fk_inventory_loss_declarations_approval` FOREIGN KEY (`approval_request_id`) REFERENCES `approvals_approval_requests` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_loss_declarations_cancel_approval` FOREIGN KEY (`cancel_approval_request_id`) REFERENCES `approvals_approval_requests` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_loss_declarations_cancel_reason` FOREIGN KEY (`cancel_reason_code_id`) REFERENCES `catalog_reason_codes` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_loss_declarations_cancelled_by` FOREIGN KEY (`cancelled_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_loss_declarations_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_loss_declarations_declared_by` FOREIGN KEY (`declared_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_loss_declarations_device` FOREIGN KEY (`created_device_id`) REFERENCES `identity_devices` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_loss_declarations_location` FOREIGN KEY (`location_id`) REFERENCES `organization_locations` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_loss_declarations_lot` FOREIGN KEY (`lot_id`) REFERENCES `inventory_stock_lots` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_loss_declarations_policy` FOREIGN KEY (`policy_id`) REFERENCES `approvals_control_policies` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_loss_declarations_product` FOREIGN KEY (`product_id`) REFERENCES `catalog_products` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_loss_declarations_reason` FOREIGN KEY (`reason_code_id`) REFERENCES `catalog_reason_codes` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_loss_declarations_responsibility` FOREIGN KEY (`responsibility_user_id`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_loss_declarations_site` FOREIGN KEY (`site_id`) REFERENCES `organization_sites` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_loss_declarations_unit` FOREIGN KEY (`unit_code`) REFERENCES `catalog_units` (`code`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_loss_declarations_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_inventory_loss_declarations_category` CHECK ((`category` in (_utf8mb4'MORTALITE',_utf8mb4'CASSE',_utf8mb4'DETERIORATION',_utf8mb4'IMPROPRE',_utf8mb4'DESTRUCTION',_utf8mb4'INEXPLIQUEE',_utf8mb4'VOL_SUSPECTE',_utf8mb4'ECART_TRANSFERT'))),
  CONSTRAINT `ck_inventory_loss_declarations_comment` CHECK (((`category` not in (_utf8mb4'INEXPLIQUEE',_utf8mb4'VOL_SUSPECTE')) or ((`comment` is not null) and (`comment` <> _utf8mb4'')))),
  CONSTRAINT `ck_inventory_loss_declarations_mortality` CHECK (((`category` <> _utf8mb4'MORTALITE') or (`production_lot_id` is not null) or (`incubation_batch_id` is not null))),
  CONSTRAINT `ck_inventory_loss_declarations_qty` CHECK (((`quantity_base` > 0) and (`quantity` > 0))),
  CONSTRAINT `ck_inventory_loss_declarations_status` CHECK ((`status` in (_utf8mb4'RECORDED',_utf8mb4'PENDING_APPROVAL',_utf8mb4'APPROVED',_utf8mb4'REJECTED_RETURNED',_utf8mb4'REJECTED_UNJUSTIFIED',_utf8mb4'CANCELLATION_PENDING',_utf8mb4'CANCELLED')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_inventory_loss_declarations_no_delete` BEFORE DELETE ON `inventory_loss_declarations` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_loss_declarations : suppression physique interdite (INV-GLO-03) ; utiliser CANCELLED.';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `inventory_overhead_entries`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `inventory_overhead_entries` (
  `id` binary(16) NOT NULL,
  `site_id` binary(16) NOT NULL,
  `label` varchar(200) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `total_xaf` bigint NOT NULL,
  `status` varchar(20) COLLATE utf8mb4_0900_as_cs NOT NULL DEFAULT 'RECORDED',
  `cancelled_at` datetime(6) DEFAULT NULL,
  `cancelled_by` binary(16) DEFAULT NULL,
  `cancel_reason_code_id` binary(16) DEFAULT NULL,
  `cancel_comment` text COLLATE utf8mb4_0900_as_cs,
  `cancel_approval_request_id` binary(16) DEFAULT NULL,
  `occurred_at` datetime(6) NOT NULL,
  `business_date` date GENERATED ALWAYS AS (cast(convert_tz(`occurred_at`,_utf8mb4'+00:00',_utf8mb4'+01:00') as date)) STORED,
  `client_created_at` datetime(6) DEFAULT NULL,
  `received_at_server` datetime(6) DEFAULT NULL,
  `command_id` binary(16) DEFAULT NULL,
  `created_device_id` binary(16) DEFAULT NULL,
  `captured_offline` tinyint(1) NOT NULL DEFAULT '0',
  `clock_suspect` tinyint(1) NOT NULL DEFAULT '0',
  `backdated_reason` text COLLATE utf8mb4_0900_as_cs,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `updated_by` binary(16) DEFAULT NULL,
  `version` int NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_inventory_overhead_entries_command` (`command_id`),
  KEY `ix_inventory_overhead_entries_site_date` (`site_id`,`business_date`),
  KEY `fk_inventory_overhead_entries_cancelled_by` (`cancelled_by`),
  KEY `fk_inventory_overhead_entries_created_device` (`created_device_id`),
  KEY `fk_inventory_overhead_entries_created_by` (`created_by`),
  KEY `fk_inventory_overhead_entries_updated_by` (`updated_by`),
  CONSTRAINT `fk_inventory_overhead_entries_cancelled_by` FOREIGN KEY (`cancelled_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_overhead_entries_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_overhead_entries_created_device` FOREIGN KEY (`created_device_id`) REFERENCES `identity_devices` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_overhead_entries_site` FOREIGN KEY (`site_id`) REFERENCES `organization_sites` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_overhead_entries_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_inventory_overhead_entries_cancel` CHECK ((((`status` = _utf8mb4'CANCELLED') and (`cancelled_at` is not null) and (`cancelled_by` is not null)) or ((`status` <> _utf8mb4'CANCELLED') and (`cancelled_at` is null) and (`cancelled_by` is null) and (`cancel_reason_code_id` is null) and (`cancel_comment` is null)))),
  CONSTRAINT `ck_inventory_overhead_entries_status` CHECK ((`status` in (_utf8mb4'RECORDED',_utf8mb4'CANCELLED'))),
  CONSTRAINT `ck_inventory_overhead_entries_total` CHECK ((`total_xaf` > 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_inventory_overhead_entries_update_guard` BEFORE UPDATE ON `inventory_overhead_entries` FOR EACH ROW BEGIN
  IF NOT (
    NEW.site_id <=> OLD.site_id AND NEW.label <=> OLD.label AND NEW.total_xaf <=> OLD.total_xaf AND
    NEW.occurred_at <=> OLD.occurred_at AND NEW.command_id <=> OLD.command_id AND
    NEW.created_at <=> OLD.created_at AND NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_overhead_entries : saisie non modifiable ; annuler puis ressaisir.';
  END IF;
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_inventory_overhead_entries_no_delete` BEFORE DELETE ON `inventory_overhead_entries` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_overhead_entries : suppression physique interdite (INV-GLO-03).';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `inventory_overhead_entry_lines`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `inventory_overhead_entry_lines` (
  `id` binary(16) NOT NULL,
  `entry_id` binary(16) NOT NULL,
  `species_group` varchar(10) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `amount_xaf` bigint NOT NULL,
  `cost_entry_id` binary(16) NOT NULL,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_inventory_overhead_entry_lines_species` (`entry_id`,`species_group`),
  UNIQUE KEY `uq_inventory_overhead_entry_lines_cost_entry` (`cost_entry_id`),
  CONSTRAINT `fk_inventory_overhead_entry_lines_cost_entry` FOREIGN KEY (`cost_entry_id`) REFERENCES `inventory_cost_entries` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_overhead_entry_lines_entry` FOREIGN KEY (`entry_id`) REFERENCES `inventory_overhead_entries` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_inventory_overhead_entry_lines_amount` CHECK ((`amount_xaf` > 0)),
  CONSTRAINT `ck_inventory_overhead_entry_lines_species` CHECK ((`species_group` in (_utf8mb4'VOLAILLE',_utf8mb4'PORC')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_inventory_overhead_entry_lines_no_update` BEFORE UPDATE ON `inventory_overhead_entry_lines` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_overhead_entry_lines : ligne immuable.';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_inventory_overhead_entry_lines_no_delete` BEFORE DELETE ON `inventory_overhead_entry_lines` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_overhead_entry_lines : suppression physique interdite (INV-GLO-03).';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `inventory_product_valuations`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `inventory_product_valuations` (
  `product_id` binary(16) NOT NULL,
  `avg_unit_cost_xaf` decimal(14,2) NOT NULL DEFAULT '0.00',
  `qty_basis` decimal(14,3) NOT NULL DEFAULT '0.000',
  `last_entry_move_id` binary(16) DEFAULT NULL,
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`product_id`),
  KEY `fk_inventory_product_valuations_move` (`last_entry_move_id`),
  CONSTRAINT `fk_inventory_product_valuations_move` FOREIGN KEY (`last_entry_move_id`) REFERENCES `inventory_stock_moves` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_product_valuations_product` FOREIGN KEY (`product_id`) REFERENCES `catalog_products` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `inventory_stock_allocation_entries`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `inventory_stock_allocation_entries` (
  `id` binary(16) NOT NULL,
  `allocation_id` binary(16) NOT NULL,
  `entry_type` varchar(20) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `quantity` decimal(14,3) NOT NULL,
  `stock_move_id` binary(16) DEFAULT NULL,
  `occurred_at` datetime(6) NOT NULL,
  `command_id` binary(16) DEFAULT NULL,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_inventory_stock_allocation_entries_allocation` (`allocation_id`),
  KEY `fk_inventory_stock_allocation_entries_move` (`stock_move_id`),
  KEY `fk_inventory_stock_allocation_entries_created_by` (`created_by`),
  CONSTRAINT `fk_inventory_stock_allocation_entries_allocation` FOREIGN KEY (`allocation_id`) REFERENCES `inventory_stock_allocations` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_stock_allocation_entries_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_stock_allocation_entries_move` FOREIGN KEY (`stock_move_id`) REFERENCES `inventory_stock_moves` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_inventory_stock_allocation_entries_type` CHECK ((`entry_type` in (_utf8mb4'GRANT',_utf8mb4'INCREASE',_utf8mb4'CONSUME',_utf8mb4'RELEASE',_utf8mb4'REVOKE',_utf8mb4'TRANSFER',_utf8mb4'ADJUST')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_inventory_stock_allocation_entries_no_update` BEFORE UPDATE ON `inventory_stock_allocation_entries` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_stock_allocation_entries : registre immuable.';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_inventory_stock_allocation_entries_no_delete` BEFORE DELETE ON `inventory_stock_allocation_entries` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_stock_allocation_entries : suppression physique interdite.';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `inventory_stock_allocations`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `inventory_stock_allocations` (
  `id` binary(16) NOT NULL,
  `allocation_type` varchar(20) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `location_id` binary(16) NOT NULL,
  `product_id` binary(16) NOT NULL,
  `lot_id` binary(16) DEFAULT NULL,
  `holder_user_id` binary(16) DEFAULT NULL,
  `holder_device_id` binary(16) DEFAULT NULL,
  `sales_order_line_id` binary(16) DEFAULT NULL,
  `quantity_granted` decimal(14,3) NOT NULL,
  `quantity_remaining` decimal(14,3) NOT NULL,
  `valid_until` datetime(6) DEFAULT NULL,
  `status` varchar(10) COLLATE utf8mb4_0900_as_cs NOT NULL DEFAULT 'ACTIVE',
  `close_cause` varchar(20) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `revocation_pending` tinyint(1) NOT NULL DEFAULT '0',
  `granted_by` binary(16) NOT NULL,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `updated_by` binary(16) DEFAULT NULL,
  `version` int NOT NULL DEFAULT '1',
  `active_device_quota_key` varchar(200) COLLATE utf8mb4_0900_as_cs GENERATED ALWAYS AS (if(((`status` = _utf8mb4'ACTIVE') and (`allocation_type` = _utf8mb4'DEVICE_QUOTA')),concat(hex(`holder_user_id`),_utf8mb4'-',hex(`holder_device_id`),_utf8mb4'-',hex(`location_id`),_utf8mb4'-',hex(`product_id`),_utf8mb4'-',hex(coalesce(`lot_id`,0x00000000000000000000000000000000))),NULL)) STORED,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_inventory_stock_allocations_active_device_quota` (`active_device_quota_key`),
  KEY `ix_inventory_stock_allocations_location_status` (`location_id`,`product_id`,`status`),
  KEY `ix_inventory_stock_allocations_holder_device` (`holder_device_id`,`status`),
  KEY `fk_inventory_stock_allocations_product` (`product_id`),
  KEY `fk_inventory_stock_allocations_lot` (`lot_id`),
  KEY `fk_inventory_stock_allocations_holder_user` (`holder_user_id`),
  KEY `fk_inventory_stock_allocations_granted_by` (`granted_by`),
  KEY `fk_inventory_stock_allocations_created_by` (`created_by`),
  KEY `fk_inventory_stock_allocations_updated_by` (`updated_by`),
  CONSTRAINT `fk_inventory_stock_allocations_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_stock_allocations_granted_by` FOREIGN KEY (`granted_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_stock_allocations_holder_device` FOREIGN KEY (`holder_device_id`) REFERENCES `identity_devices` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_stock_allocations_holder_user` FOREIGN KEY (`holder_user_id`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_stock_allocations_location` FOREIGN KEY (`location_id`) REFERENCES `organization_locations` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_stock_allocations_lot` FOREIGN KEY (`lot_id`) REFERENCES `inventory_stock_lots` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_stock_allocations_product` FOREIGN KEY (`product_id`) REFERENCES `catalog_products` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_stock_allocations_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_inventory_stock_allocations_close_cause` CHECK (((`close_cause` is null) or (`close_cause` in (_utf8mb4'RELEASED',_utf8mb4'CONSUMED',_utf8mb4'CANCELLED',_utf8mb4'TRANSFERRED',_utf8mb4'EXPIRED_RELEASED')))),
  CONSTRAINT `ck_inventory_stock_allocations_holder` CHECK ((((`allocation_type` = _utf8mb4'DEVICE_QUOTA') and (`holder_user_id` is not null) and (`holder_device_id` is not null) and (`sales_order_line_id` is null)) or ((`allocation_type` = _utf8mb4'ORDER_RESERVATION') and (`sales_order_line_id` is not null) and (`holder_user_id` is null) and (`holder_device_id` is null)))),
  CONSTRAINT `ck_inventory_stock_allocations_status` CHECK ((`status` in (_utf8mb4'ACTIVE',_utf8mb4'CLOSED',_utf8mb4'REVOKED'))),
  CONSTRAINT `ck_inventory_stock_allocations_type` CHECK ((`allocation_type` in (_utf8mb4'DEVICE_QUOTA',_utf8mb4'ORDER_RESERVATION')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_inventory_stock_allocations_no_delete` BEFORE DELETE ON `inventory_stock_allocations` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_stock_allocations : suppression physique interdite (INV-GLO-03).';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `inventory_stock_balances`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `inventory_stock_balances` (
  `location_id` binary(16) NOT NULL,
  `product_id` binary(16) NOT NULL,
  `lot_key` binary(16) NOT NULL,
  `qty_on_hand` decimal(14,3) NOT NULL DEFAULT '0.000',
  `qty_reserved` decimal(14,3) NOT NULL DEFAULT '0.000',
  `qty_allocated` decimal(14,3) NOT NULL DEFAULT '0.000',
  `value_xaf` bigint NOT NULL DEFAULT '0',
  `last_move_at` datetime(6) DEFAULT NULL,
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `row_version` bigint NOT NULL DEFAULT '0',
  PRIMARY KEY (`location_id`,`product_id`,`lot_key`),
  KEY `ix_inventory_stock_balances_product` (`product_id`,`location_id`),
  CONSTRAINT `fk_inventory_stock_balances_location` FOREIGN KEY (`location_id`) REFERENCES `organization_locations` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_stock_balances_product` FOREIGN KEY (`product_id`) REFERENCES `catalog_products` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_inventory_stock_balances_allocated` CHECK ((`qty_allocated` >= 0)),
  CONSTRAINT `ck_inventory_stock_balances_reserved` CHECK ((`qty_reserved` >= 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `inventory_stock_lots`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `inventory_stock_lots` (
  `id` binary(16) NOT NULL,
  `lot_code` varchar(40) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `product_id` binary(16) DEFAULT NULL,
  `origin_type` varchar(20) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `origin_id` binary(16) DEFAULT NULL,
  `supplier_id` binary(16) DEFAULT NULL,
  `supplier_lot_ref` varchar(60) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `expiry_date` date DEFAULT NULL,
  `fifo_rank_at` datetime(6) NOT NULL,
  `status` varchar(10) COLLATE utf8mb4_0900_as_cs NOT NULL DEFAULT 'OPEN',
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_inventory_stock_lots_code` (`lot_code`),
  KEY `ix_inventory_stock_lots_origin` (`origin_type`,`origin_id`),
  KEY `ix_inventory_stock_lots_expiry` (`expiry_date`),
  KEY `fk_inventory_stock_lots_product` (`product_id`),
  KEY `fk_inventory_stock_lots_supplier` (`supplier_id`),
  KEY `fk_inventory_stock_lots_created_by` (`created_by`),
  CONSTRAINT `fk_inventory_stock_lots_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_stock_lots_product` FOREIGN KEY (`product_id`) REFERENCES `catalog_products` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_stock_lots_supplier` FOREIGN KEY (`supplier_id`) REFERENCES `procurement_suppliers` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_inventory_stock_lots_origin_type` CHECK ((`origin_type` in (_utf8mb4'PRODUCTION_LOT',_utf8mb4'INCUBATION_BATCH',_utf8mb4'SUPPLIER_LOT',_utf8mb4'COLLECTION',_utf8mb4'TRANSFORMATION'))),
  CONSTRAINT `ck_inventory_stock_lots_status` CHECK ((`status` in (_utf8mb4'OPEN',_utf8mb4'CLOSED')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_inventory_stock_lots_update_guard` BEFORE UPDATE ON `inventory_stock_lots` FOR EACH ROW BEGIN
  IF NOT (
    NEW.lot_code <=> OLD.lot_code AND NEW.product_id <=> OLD.product_id AND
    NEW.origin_type <=> OLD.origin_type AND NEW.origin_id <=> OLD.origin_id AND
    NEW.supplier_id <=> OLD.supplier_id AND NEW.supplier_lot_ref <=> OLD.supplier_lot_ref AND
    NEW.expiry_date <=> OLD.expiry_date AND NEW.fifo_rank_at <=> OLD.fifo_rank_at AND
    NEW.created_at <=> OLD.created_at AND NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_stock_lots : seul le statut est modifiable.';
  END IF;
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_inventory_stock_lots_no_delete` BEFORE DELETE ON `inventory_stock_lots` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_stock_lots : suppression physique interdite (INV-GLO-03).';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `inventory_stock_moves`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `inventory_stock_moves` (
  `id` binary(16) NOT NULL,
  `product_id` binary(16) NOT NULL,
  `lot_id` binary(16) DEFAULT NULL,
  `quantity` decimal(14,3) NOT NULL,
  `from_location_id` binary(16) NOT NULL,
  `to_location_id` binary(16) NOT NULL,
  `move_type` varchar(30) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `reason_code_id` binary(16) DEFAULT NULL,
  `unit_cost_xaf` bigint NOT NULL,
  `value_xaf` bigint NOT NULL,
  `occurred_at` datetime(6) NOT NULL,
  `business_date` date GENERATED ALWAYS AS (cast(convert_tz(`occurred_at`,_utf8mb4'+00:00',_utf8mb4'+01:00') as date)) STORED,
  `recorded_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `source_doc_type` varchar(20) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `source_doc_id` binary(16) NOT NULL,
  `source_line_id` binary(16) DEFAULT NULL,
  `allocation_id` binary(16) DEFAULT NULL,
  `cost_object_type` varchar(20) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `cost_object_id` binary(16) DEFAULT NULL,
  `is_reversal` tinyint(1) NOT NULL DEFAULT '0',
  `reverses_move_id` binary(16) DEFAULT NULL,
  `origin_move_id` binary(16) DEFAULT NULL,
  `origin_seq` int unsigned DEFAULT NULL,
  `created_by` binary(16) NOT NULL,
  `created_device_id` binary(16) DEFAULT NULL,
  `command_id` binary(16) DEFAULT NULL,
  `captured_offline` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_inventory_stock_moves_reverses` (`reverses_move_id`),
  UNIQUE KEY `uq_inventory_stock_moves_origin_seq` (`origin_move_id`,`origin_seq`),
  KEY `ix_inventory_stock_moves_from` (`from_location_id`,`product_id`,`occurred_at`),
  KEY `ix_inventory_stock_moves_to` (`to_location_id`,`product_id`,`occurred_at`),
  KEY `ix_inventory_stock_moves_source_doc` (`source_doc_type`,`source_doc_id`),
  KEY `ix_inventory_stock_moves_lot` (`lot_id`),
  KEY `ix_inventory_stock_moves_business_date` (`business_date`,`move_type`),
  KEY `ix_inventory_stock_moves_command` (`command_id`),
  KEY `fk_inventory_stock_moves_product` (`product_id`),
  KEY `fk_inventory_stock_moves_reason` (`reason_code_id`),
  KEY `fk_inventory_stock_moves_created_by` (`created_by`),
  KEY `fk_inventory_stock_moves_device` (`created_device_id`),
  KEY `fk_inventory_stock_moves_allocation` (`allocation_id`),
  CONSTRAINT `fk_inventory_stock_moves_allocation` FOREIGN KEY (`allocation_id`) REFERENCES `inventory_stock_allocations` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_stock_moves_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_stock_moves_device` FOREIGN KEY (`created_device_id`) REFERENCES `identity_devices` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_stock_moves_from` FOREIGN KEY (`from_location_id`) REFERENCES `organization_locations` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_stock_moves_lot` FOREIGN KEY (`lot_id`) REFERENCES `inventory_stock_lots` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_stock_moves_origin` FOREIGN KEY (`origin_move_id`) REFERENCES `inventory_stock_moves` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_stock_moves_product` FOREIGN KEY (`product_id`) REFERENCES `catalog_products` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_stock_moves_reason` FOREIGN KEY (`reason_code_id`) REFERENCES `catalog_reason_codes` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_stock_moves_reverses` FOREIGN KEY (`reverses_move_id`) REFERENCES `inventory_stock_moves` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_stock_moves_to` FOREIGN KEY (`to_location_id`) REFERENCES `organization_locations` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_inventory_stock_moves_cancellation_doc` CHECK (((`source_doc_type` <> _utf8mb4'SALE_CANCELLATION') or (`move_type` = _utf8mb4'CUSTOMER_RETURN'))),
  CONSTRAINT `ck_inventory_stock_moves_cost_object` CHECK (((`cost_object_type` is null) or (`cost_object_type` in (_utf8mb4'PRODUCTION_LOT',_utf8mb4'INCUBATION_BATCH',_utf8mb4'SITE')))),
  CONSTRAINT `ck_inventory_stock_moves_delivery_doc` CHECK (((`move_type` = _utf8mb4'DELIVERY') = (`source_doc_type` = _utf8mb4'DELIVERY'))),
  CONSTRAINT `ck_inventory_stock_moves_locations` CHECK ((`from_location_id` <> `to_location_id`)),
  CONSTRAINT `ck_inventory_stock_moves_move_type` CHECK ((`move_type` in (_utf8mb4'OPENING_BALANCE',_utf8mb4'PURCHASE_RECEIPT',_utf8mb4'SUPPLIER_RETURN',_utf8mb4'TRANSFER_DISPATCH',_utf8mb4'TRANSFER_RECEIPT',_utf8mb4'TRANSFER_DISCREPANCY',_utf8mb4'INTERNAL_MOVE',_utf8mb4'SALE',_utf8mb4'CUSTOMER_RETURN',_utf8mb4'DELIVERY',_utf8mb4'LOSS',_utf8mb4'LOSS_PENDING',_utf8mb4'LOSS_CONFIRMATION',_utf8mb4'LOSS_RELEASE',_utf8mb4'CONSUMPTION',_utf8mb4'CONSUMPTION_REVERSAL',_utf8mb4'PRODUCTION_OUTPUT',_utf8mb4'PRODUCTION_INPUT',_utf8mb4'INVENTORY_GAIN',_utf8mb4'INVENTORY_LOSS'))),
  CONSTRAINT `ck_inventory_stock_moves_origin` CHECK ((((`origin_move_id` is null) and (`origin_seq` is null)) or ((`origin_move_id` is not null) and (`origin_seq` is not null) and (`origin_seq` >= 1) and (`is_reversal` = false) and (`move_type` in (_utf8mb4'CUSTOMER_RETURN',_utf8mb4'DELIVERY'))))),
  CONSTRAINT `ck_inventory_stock_moves_quantity` CHECK ((`quantity` > 0)),
  CONSTRAINT `ck_inventory_stock_moves_reversal` CHECK ((((`is_reversal` = false) and (`reverses_move_id` is null)) or ((`is_reversal` = true) and (`reverses_move_id` is not null)))),
  CONSTRAINT `ck_inventory_stock_moves_settlement` CHECK (((`move_type` not in (_utf8mb4'CUSTOMER_RETURN',_utf8mb4'DELIVERY')) or (`origin_move_id` is not null))),
  CONSTRAINT `ck_inventory_stock_moves_source_doc_type` CHECK ((`source_doc_type` in (_utf8mb4'SALE',_utf8mb4'TRANSFER',_utf8mb4'LOSS',_utf8mb4'CONSUMPTION',_utf8mb4'INVENTORY_COUNT',_utf8mb4'GOODS_RECEIPT',_utf8mb4'EGG_COLLECTION',_utf8mb4'INCUBATION_EVENT',_utf8mb4'LOT_ENTRY',_utf8mb4'SLAUGHTER',_utf8mb4'LOT_TRANSFER',_utf8mb4'SALE_CANCELLATION',_utf8mb4'DELIVERY'))),
  CONSTRAINT `ck_inventory_stock_moves_unit_cost` CHECK ((`unit_cost_xaf` >= 0)),
  CONSTRAINT `ck_inventory_stock_moves_value` CHECK ((`value_xaf` >= 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_inventory_stock_moves_settlement_guard` BEFORE INSERT ON `inventory_stock_moves` FOR EACH ROW BEGIN
  DECLARE r_type VARCHAR(30);
  DECLARE o_product BINARY(16);
  DECLARE o_lot BINARY(16);
  DECLARE o_type VARCHAR(30);
  DECLARE o_qty DECIMAL(14,3);
  DECLARE o_value BIGINT;
  DECLARE o_from BINARY(16);
  DECLARE o_to BINARY(16);
  DECLARE o_reversal TINYINT(1);
  DECLARE o_to_type VARCHAR(20);
  DECLARE n_to_type VARCHAR(20);
  DECLARE n_to_site BINARY(16);
  DECLARE n_from_site BINARY(16);
  DECLARE n_done BIGINT;
  DECLARE q_done DECIMAL(14,3);
  DECLARE v_done DECIMAL(30,0);

  IF NEW.reverses_move_id IS NOT NULL THEN
    SELECT move_type INTO r_type FROM inventory_stock_moves WHERE id = NEW.reverses_move_id;
    IF r_type IN ('SALE', 'DELIVERY', 'CUSTOMER_RETURN') THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_stock_moves : une vente, une livraison ou un retour ne s''inverse pas (INV-STK-17, ADR-029).';
    END IF;
  END IF;

  -- Une vente vers « à livrer » cible l'emplacement « à livrer » du site de sa source (INV-STK-18).
  IF NEW.origin_move_id IS NULL AND NEW.move_type = 'SALE' THEN
    SELECT location_type, site_id INTO n_to_type, n_to_site FROM organization_locations WHERE id = NEW.to_location_id;
    IF n_to_type = 'V_TO_DELIVER' THEN
      SELECT site_id INTO n_from_site FROM organization_locations WHERE id = NEW.from_location_id;
      IF n_from_site IS NULL OR n_from_site <> n_to_site THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_stock_moves : « à livrer » doit être celui du site de la source (INV-STK-18).';
      END IF;
    END IF;
  END IF;

  IF NEW.origin_move_id IS NOT NULL THEN
    SELECT product_id, lot_id, move_type, quantity, value_xaf, from_location_id, to_location_id, is_reversal
      INTO o_product, o_lot, o_type, o_qty, o_value, o_from, o_to, o_reversal
      FROM inventory_stock_moves WHERE id = NEW.origin_move_id;
    IF o_type IS NULL OR o_type <> 'SALE' OR o_reversal = 1 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_stock_moves : l''origine doit être un mouvement SALE non inverse (INV-STK-17).';
    END IF;
    IF NEW.product_id <> o_product OR NOT (NEW.lot_id <=> o_lot) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_stock_moves : produit ou lot différent de l''origine (INV-STK-17).';
    END IF;
    IF NEW.from_location_id <> o_to THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_stock_moves : départ différent de l''arrivée de l''origine (INV-STK-17).';
    END IF;
    IF NEW.move_type = 'CUSTOMER_RETURN' AND NEW.to_location_id <> o_from THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_stock_moves : un retour revient au départ de l''origine (INV-STK-17).';
    END IF;
    IF NEW.move_type = 'DELIVERY' THEN
      SELECT location_type INTO o_to_type FROM organization_locations WHERE id = o_to;
      SELECT location_type INTO n_to_type FROM organization_locations WHERE id = NEW.to_location_id;
      IF o_to_type IS NULL OR o_to_type <> 'V_TO_DELIVER' OR n_to_type IS NULL OR n_to_type <> 'V_CUSTOMER' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_stock_moves : une livraison va de V_TO_DELIVER vers V_CUSTOMER (INV-STK-17).';
      END IF;
    END IF;
    SELECT COUNT(*), COALESCE(SUM(quantity), 0), COALESCE(SUM(value_xaf), 0)
      INTO n_done, q_done, v_done
      FROM inventory_stock_moves WHERE origin_move_id = NEW.origin_move_id;
    IF NEW.origin_seq IS NULL OR NEW.origin_seq <> n_done + 1 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_stock_moves : séquence de rattachement invalide (INV-STK-17).';
    END IF;
    IF q_done + NEW.quantity > o_qty THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_stock_moves : quantité au-delà de l''origine (INV-STK-17).';
    END IF;
    IF v_done + NEW.value_xaf > o_value THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_stock_moves : valeur au-delà de l''origine (INV-STK-17).';
    END IF;
    IF q_done + NEW.quantity = o_qty AND v_done + NEW.value_xaf <> o_value THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_stock_moves : le dernier mouvement doit solder la valeur exacte (INV-STK-17).';
    END IF;
  END IF;
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_inventory_stock_moves_no_update` BEFORE UPDATE ON `inventory_stock_moves` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_stock_moves : registre immuable (INV-STK-04) ; créer un mouvement inverse.';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_inventory_stock_moves_no_delete` BEFORE DELETE ON `inventory_stock_moves` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_stock_moves : suppression physique interdite (INV-STK-04).';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `inventory_stock_thresholds`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `inventory_stock_thresholds` (
  `id` binary(16) NOT NULL,
  `location_id` binary(16) NOT NULL,
  `product_id` binary(16) NOT NULL,
  `min_qty_base` decimal(14,3) NOT NULL,
  `target_qty_base` decimal(14,3) NOT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `updated_by` binary(16) DEFAULT NULL,
  `version` int NOT NULL DEFAULT '1',
  `active_key` varchar(65) COLLATE utf8mb4_0900_as_cs GENERATED ALWAYS AS (if(`is_active`,concat(hex(`location_id`),_utf8mb4'-',hex(`product_id`)),NULL)) STORED,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_inventory_stock_thresholds_active` (`active_key`),
  KEY `fk_inventory_stock_thresholds_location` (`location_id`),
  KEY `fk_inventory_stock_thresholds_product` (`product_id`),
  KEY `fk_inventory_stock_thresholds_created_by` (`created_by`),
  KEY `fk_inventory_stock_thresholds_updated_by` (`updated_by`),
  CONSTRAINT `fk_inventory_stock_thresholds_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_stock_thresholds_location` FOREIGN KEY (`location_id`) REFERENCES `organization_locations` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_stock_thresholds_product` FOREIGN KEY (`product_id`) REFERENCES `catalog_products` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_stock_thresholds_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_inventory_stock_thresholds_qty` CHECK (((`min_qty_base` >= 0) and (`target_qty_base` >= `min_qty_base`)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_inventory_stock_thresholds_no_delete` BEFORE DELETE ON `inventory_stock_thresholds` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_stock_thresholds : suppression physique interdite (INV-GLO-03) ; utiliser is_active=false.';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `inventory_stock_transfer_lines`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `inventory_stock_transfer_lines` (
  `id` binary(16) NOT NULL,
  `transfer_id` binary(16) NOT NULL,
  `product_id` binary(16) NOT NULL,
  `lot_id` binary(16) DEFAULT NULL,
  `unit_code` varchar(20) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `requested_qty_base` decimal(14,3) DEFAULT NULL,
  `dispatched_qty_base` decimal(14,3) DEFAULT NULL,
  `received_qty_base` decimal(14,3) DEFAULT NULL,
  `discrepancy_qty_base` decimal(14,3) GENERATED ALWAYS AS (if(((`dispatched_qty_base` is not null) and (`received_qty_base` is not null)),(`dispatched_qty_base` - `received_qty_base`),NULL)) STORED,
  `discrepancy_reason_code_id` binary(16) DEFAULT NULL,
  `returned_qty_base` decimal(14,3) NOT NULL DEFAULT '0.000',
  PRIMARY KEY (`id`),
  KEY `ix_inventory_stock_transfer_lines_transfer` (`transfer_id`),
  KEY `fk_inventory_stock_transfer_lines_product` (`product_id`),
  KEY `fk_inventory_stock_transfer_lines_lot` (`lot_id`),
  KEY `fk_inventory_stock_transfer_lines_unit` (`unit_code`),
  KEY `fk_inventory_stock_transfer_lines_reason` (`discrepancy_reason_code_id`),
  CONSTRAINT `fk_inventory_stock_transfer_lines_lot` FOREIGN KEY (`lot_id`) REFERENCES `inventory_stock_lots` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_stock_transfer_lines_product` FOREIGN KEY (`product_id`) REFERENCES `catalog_products` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_stock_transfer_lines_reason` FOREIGN KEY (`discrepancy_reason_code_id`) REFERENCES `catalog_reason_codes` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_stock_transfer_lines_transfer` FOREIGN KEY (`transfer_id`) REFERENCES `inventory_stock_transfers` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_stock_transfer_lines_unit` FOREIGN KEY (`unit_code`) REFERENCES `catalog_units` (`code`) ON DELETE RESTRICT,
  CONSTRAINT `ck_inventory_stock_transfer_lines_qty` CHECK ((((`requested_qty_base` is null) or (`requested_qty_base` >= 0)) and ((`dispatched_qty_base` is null) or (`dispatched_qty_base` >= 0)) and ((`received_qty_base` is null) or (`received_qty_base` >= 0)) and (`returned_qty_base` >= 0)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_inventory_stock_transfer_lines_no_delete` BEFORE DELETE ON `inventory_stock_transfer_lines` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_stock_transfer_lines : suit le transfert, jamais supprimée indépendamment.';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `inventory_stock_transfers`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `inventory_stock_transfers` (
  `id` binary(16) NOT NULL,
  `doc_number` varchar(40) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `local_ref` varchar(20) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `site_id` binary(16) NOT NULL,
  `transfer_kind` varchar(10) COLLATE utf8mb4_0900_as_cs NOT NULL DEFAULT 'STANDARD',
  `from_location_id` binary(16) NOT NULL,
  `to_location_id` binary(16) NOT NULL,
  `status` varchar(20) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `requested_by` binary(16) DEFAULT NULL,
  `requested_at` datetime(6) DEFAULT NULL,
  `dispatched_by` binary(16) DEFAULT NULL,
  `dispatched_at` datetime(6) DEFAULT NULL,
  `carrier_user_id` binary(16) DEFAULT NULL,
  `carrier_name` varchar(200) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `received_by` binary(16) DEFAULT NULL,
  `received_at` datetime(6) DEFAULT NULL,
  `matched_transfer_id` binary(16) DEFAULT NULL,
  `sales_order_id` binary(16) DEFAULT NULL,
  `approval_request_id` binary(16) DEFAULT NULL,
  `notes` text COLLATE utf8mb4_0900_as_cs,
  `occurred_at` datetime(6) NOT NULL,
  `client_created_at` datetime(6) DEFAULT NULL,
  `received_at_server` datetime(6) DEFAULT NULL,
  `command_id` binary(16) DEFAULT NULL,
  `created_device_id` binary(16) DEFAULT NULL,
  `captured_offline` tinyint(1) NOT NULL DEFAULT '0',
  `clock_suspect` tinyint(1) NOT NULL DEFAULT '0',
  `backdated_reason` text COLLATE utf8mb4_0900_as_cs,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `updated_by` binary(16) DEFAULT NULL,
  `version` int NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_inventory_stock_transfers_doc_number` (`doc_number`),
  UNIQUE KEY `uq_inventory_stock_transfers_command` (`command_id`),
  UNIQUE KEY `uq_inventory_stock_transfers_device_ref` (`created_device_id`,`local_ref`),
  KEY `ix_inventory_stock_transfers_to_status` (`to_location_id`,`status`),
  KEY `ix_inventory_stock_transfers_from_status` (`from_location_id`,`status`),
  KEY `ix_inventory_stock_transfers_dispatched` (`dispatched_at`),
  KEY `fk_inventory_stock_transfers_site` (`site_id`),
  KEY `fk_inventory_stock_transfers_requested_by` (`requested_by`),
  KEY `fk_inventory_stock_transfers_dispatched_by` (`dispatched_by`),
  KEY `fk_inventory_stock_transfers_carrier` (`carrier_user_id`),
  KEY `fk_inventory_stock_transfers_received_by` (`received_by`),
  KEY `fk_inventory_stock_transfers_matched` (`matched_transfer_id`),
  KEY `fk_inventory_stock_transfers_approval` (`approval_request_id`),
  KEY `fk_inventory_stock_transfers_created_by` (`created_by`),
  KEY `fk_inventory_stock_transfers_updated_by` (`updated_by`),
  CONSTRAINT `fk_inventory_stock_transfers_approval` FOREIGN KEY (`approval_request_id`) REFERENCES `approvals_approval_requests` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_stock_transfers_carrier` FOREIGN KEY (`carrier_user_id`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_stock_transfers_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_stock_transfers_created_device` FOREIGN KEY (`created_device_id`) REFERENCES `identity_devices` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_stock_transfers_dispatched_by` FOREIGN KEY (`dispatched_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_stock_transfers_from` FOREIGN KEY (`from_location_id`) REFERENCES `organization_locations` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_stock_transfers_matched` FOREIGN KEY (`matched_transfer_id`) REFERENCES `inventory_stock_transfers` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_stock_transfers_received_by` FOREIGN KEY (`received_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_stock_transfers_requested_by` FOREIGN KEY (`requested_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_stock_transfers_site` FOREIGN KEY (`site_id`) REFERENCES `organization_sites` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_stock_transfers_to` FOREIGN KEY (`to_location_id`) REFERENCES `organization_locations` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_stock_transfers_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_inventory_stock_transfers_kind` CHECK ((`transfer_kind` in (_utf8mb4'STANDARD',_utf8mb4'INTERNAL',_utf8mb4'BLIND_RECEIPT'))),
  CONSTRAINT `ck_inventory_stock_transfers_locations` CHECK ((`from_location_id` <> `to_location_id`)),
  CONSTRAINT `ck_inventory_stock_transfers_status` CHECK ((`status` in (_utf8mb4'REQUESTED',_utf8mb4'DECLINED',_utf8mb4'CANCELLED',_utf8mb4'DISPATCHED',_utf8mb4'RECEIVED',_utf8mb4'DISCREPANCY_PENDING',_utf8mb4'CLOSED',_utf8mb4'RETURNED',_utf8mb4'COMPLETED',_utf8mb4'UNMATCHED',_utf8mb4'MATCHED')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_inventory_stock_transfers_no_delete` BEFORE DELETE ON `inventory_stock_transfers` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_stock_transfers : suppression physique interdite (INV-GLO-03) ; utiliser CANCELLED.';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `organization_locations`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `organization_locations` (
  `id` binary(16) NOT NULL,
  `site_id` binary(16) DEFAULT NULL,
  `parent_location_id` binary(16) DEFAULT NULL,
  `code` varchar(40) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `name` varchar(200) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `location_type` varchar(20) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `custody_mode` varchar(20) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `custodian_user_id` binary(16) DEFAULT NULL,
  `designated_device_id` binary(16) DEFAULT NULL,
  `capacity` int DEFAULT NULL,
  `status` varchar(20) COLLATE utf8mb4_0900_as_cs NOT NULL DEFAULT 'ACTIVE',
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `updated_by` binary(16) DEFAULT NULL,
  `version` int NOT NULL DEFAULT '1',
  `is_virtual` tinyint(1) GENERATED ALWAYS AS ((`location_type` in (_utf8mb4'V_OPENING',_utf8mb4'V_SUPPLIER',_utf8mb4'V_CUSTOMER',_utf8mb4'V_PRODUCTION',_utf8mb4'V_CONSUMPTION',_utf8mb4'V_LOSS',_utf8mb4'V_PENDING_LOSS',_utf8mb4'V_ADJUSTMENT',_utf8mb4'V_TRANSIT',_utf8mb4'V_TO_DELIVER'))) STORED,
  `active_virtual_type` varchar(20) COLLATE utf8mb4_0900_as_cs GENERATED ALWAYS AS (if(((`location_type` in (_utf8mb4'V_OPENING',_utf8mb4'V_SUPPLIER',_utf8mb4'V_CUSTOMER',_utf8mb4'V_PRODUCTION',_utf8mb4'V_CONSUMPTION',_utf8mb4'V_LOSS',_utf8mb4'V_PENDING_LOSS',_utf8mb4'V_ADJUSTMENT',_utf8mb4'V_TRANSIT')) and (`status` = _utf8mb4'ACTIVE')),`location_type`,NULL)) STORED,
  `active_mobile_custodian` binary(16) GENERATED ALWAYS AS (if(((`location_type` = _utf8mb4'MOBILE') and (`status` = _utf8mb4'ACTIVE')),`custodian_user_id`,NULL)) STORED,
  `active_to_deliver_site` binary(16) GENERATED ALWAYS AS (if(((`location_type` = _utf8mb4'V_TO_DELIVER') and (`status` = _utf8mb4'ACTIVE')),`site_id`,NULL)) STORED,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_organization_locations_site_code` (`site_id`,`code`),
  UNIQUE KEY `uq_organization_locations_active_virtual_type` (`active_virtual_type`),
  UNIQUE KEY `uq_organization_locations_active_mobile_custodian` (`active_mobile_custodian`),
  UNIQUE KEY `uq_organization_locations_active_to_deliver_site` (`active_to_deliver_site`),
  KEY `ix_organization_locations_site_type` (`site_id`,`location_type`),
  KEY `ix_organization_locations_custodian` (`custodian_user_id`),
  KEY `fk_organization_locations_parent` (`parent_location_id`),
  KEY `fk_organization_locations_device` (`designated_device_id`),
  KEY `fk_organization_locations_created_by` (`created_by`),
  KEY `fk_organization_locations_updated_by` (`updated_by`),
  CONSTRAINT `fk_organization_locations_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_organization_locations_custodian` FOREIGN KEY (`custodian_user_id`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_organization_locations_device` FOREIGN KEY (`designated_device_id`) REFERENCES `identity_devices` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_organization_locations_parent` FOREIGN KEY (`parent_location_id`) REFERENCES `organization_locations` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_organization_locations_site` FOREIGN KEY (`site_id`) REFERENCES `organization_sites` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_organization_locations_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_organization_locations_custody_mode` CHECK (((`custody_mode` is null) or (`custody_mode` in (_utf8mb4'EXCLUSIVE_USER',_utf8mb4'EXCLUSIVE_DEVICE',_utf8mb4'SHARED')))),
  CONSTRAINT `ck_organization_locations_exclusive_device` CHECK (((`custody_mode` <> _utf8mb4'EXCLUSIVE_DEVICE') or (`designated_device_id` is not null))),
  CONSTRAINT `ck_organization_locations_mobile` CHECK (((`location_type` <> _utf8mb4'MOBILE') or ((`custodian_user_id` is not null) and (`custody_mode` = _utf8mb4'EXCLUSIVE_USER')))),
  CONSTRAINT `ck_organization_locations_status` CHECK ((`status` in (_utf8mb4'ACTIVE',_utf8mb4'INACTIVE'))),
  CONSTRAINT `ck_organization_locations_type` CHECK ((`location_type` in (_utf8mb4'STORE',_utf8mb4'POS',_utf8mb4'BUILDING',_utf8mb4'PEN',_utf8mb4'INCUBATOR',_utf8mb4'HATCHER',_utf8mb4'MOBILE',_utf8mb4'SLAUGHTERHOUSE',_utf8mb4'V_OPENING',_utf8mb4'V_SUPPLIER',_utf8mb4'V_CUSTOMER',_utf8mb4'V_PRODUCTION',_utf8mb4'V_CONSUMPTION',_utf8mb4'V_LOSS',_utf8mb4'V_PENDING_LOSS',_utf8mb4'V_ADJUSTMENT',_utf8mb4'V_TRANSIT',_utf8mb4'V_TO_DELIVER'))),
  CONSTRAINT `ck_organization_locations_virtual_site` CHECK ((((`is_virtual` = true) and (`site_id` is null) and (`location_type` <> _utf8mb4'V_TO_DELIVER')) or ((`is_virtual` = false) and (`site_id` is not null)) or ((`location_type` = _utf8mb4'V_TO_DELIVER') and (`site_id` is not null))))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_organization_locations_pen_parent_ins` BEFORE INSERT ON `organization_locations` FOR EACH ROW BEGIN
  DECLARE parent_type VARCHAR(20);
  IF NEW.location_type = 'PEN' THEN
    IF NEW.parent_location_id IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'organization_locations : une case (PEN) doit avoir un bâtiment parent.';
    END IF;
    SELECT location_type INTO parent_type FROM organization_locations WHERE id = NEW.parent_location_id;
    IF parent_type IS NULL OR parent_type <> 'BUILDING' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'organization_locations : le parent d''une case (PEN) doit être un bâtiment (BUILDING).';
    END IF;
  END IF;
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_organization_locations_pen_parent_upd` BEFORE UPDATE ON `organization_locations` FOR EACH ROW BEGIN
  DECLARE parent_type VARCHAR(20);
  IF NEW.location_type = 'PEN' THEN
    IF NEW.parent_location_id IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'organization_locations : une case (PEN) doit avoir un bâtiment parent.';
    END IF;
    SELECT location_type INTO parent_type FROM organization_locations WHERE id = NEW.parent_location_id;
    IF parent_type IS NULL OR parent_type <> 'BUILDING' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'organization_locations : le parent d''une case (PEN) doit être un bâtiment (BUILDING).';
    END IF;
  END IF;
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_organization_locations_no_delete` BEFORE DELETE ON `organization_locations` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'organization_locations : suppression physique interdite (INV-GLO-03) ; utiliser status=INACTIVE.';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `organization_points_of_sale`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `organization_points_of_sale` (
  `site_id` binary(16) NOT NULL,
  `sales_location_id` binary(16) NOT NULL,
  `replenishment_source_location_id` binary(16) DEFAULT NULL,
  `custody_mode` varchar(20) COLLATE utf8mb4_0900_as_cs NOT NULL DEFAULT 'EXCLUSIVE_DEVICE',
  `designated_device_id` binary(16) DEFAULT NULL,
  `opening_hours` text COLLATE utf8mb4_0900_as_cs,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `updated_by` binary(16) DEFAULT NULL,
  `version` int NOT NULL DEFAULT '1',
  PRIMARY KEY (`site_id`),
  KEY `fk_organization_pos_sales_location` (`sales_location_id`),
  KEY `fk_organization_pos_replenishment` (`replenishment_source_location_id`),
  KEY `fk_organization_pos_device` (`designated_device_id`),
  KEY `fk_organization_pos_created_by` (`created_by`),
  KEY `fk_organization_pos_updated_by` (`updated_by`),
  CONSTRAINT `fk_organization_pos_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_organization_pos_device` FOREIGN KEY (`designated_device_id`) REFERENCES `identity_devices` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_organization_pos_replenishment` FOREIGN KEY (`replenishment_source_location_id`) REFERENCES `organization_locations` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_organization_pos_sales_location` FOREIGN KEY (`sales_location_id`) REFERENCES `organization_locations` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_organization_pos_site` FOREIGN KEY (`site_id`) REFERENCES `organization_sites` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_organization_pos_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_organization_pos_custody_mode` CHECK ((`custody_mode` in (_utf8mb4'EXCLUSIVE_DEVICE',_utf8mb4'SHARED'))),
  CONSTRAINT `ck_organization_pos_device` CHECK (((`custody_mode` <> _utf8mb4'EXCLUSIVE_DEVICE') or (`designated_device_id` is not null)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_organization_pos_no_delete` BEFORE DELETE ON `organization_points_of_sale` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'organization_points_of_sale : suit le site, jamais supprimé indépendamment.';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `organization_sites`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `organization_sites` (
  `id` binary(16) NOT NULL,
  `code` varchar(10) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `name` varchar(200) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `site_type` varchar(20) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `zone_id` binary(16) NOT NULL,
  `address` text COLLATE utf8mb4_0900_as_cs,
  `lat` decimal(9,6) DEFAULT NULL,
  `lng` decimal(9,6) DEFAULT NULL,
  `status` varchar(20) COLLATE utf8mb4_0900_as_cs NOT NULL DEFAULT 'ACTIVE',
  `opened_on` date DEFAULT NULL,
  `closed_on` date DEFAULT NULL,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `updated_by` binary(16) DEFAULT NULL,
  `version` int NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_organization_sites_code` (`code`),
  KEY `ix_organization_sites_zone` (`zone_id`),
  KEY `fk_organization_sites_created_by` (`created_by`),
  KEY `fk_organization_sites_updated_by` (`updated_by`),
  CONSTRAINT `fk_organization_sites_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_organization_sites_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_organization_sites_zone` FOREIGN KEY (`zone_id`) REFERENCES `organization_zones` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_organization_sites_closed_on` CHECK ((((`status` = _utf8mb4'CLOSED') and (`closed_on` is not null)) or ((`status` <> _utf8mb4'CLOSED') and (`closed_on` is null)))),
  CONSTRAINT `ck_organization_sites_status` CHECK ((`status` in (_utf8mb4'ACTIVE',_utf8mb4'CLOSED'))),
  CONSTRAINT `ck_organization_sites_type` CHECK ((`site_type` in (_utf8mb4'FERME',_utf8mb4'MAGASIN',_utf8mb4'POINT_DE_VENTE',_utf8mb4'BUREAU')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_organization_sites_no_delete` BEFORE DELETE ON `organization_sites` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'organization_sites : suppression physique interdite (INV-GLO-03) ; utiliser CLOSED.';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `organization_system_settings`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `organization_system_settings` (
  `id` binary(16) NOT NULL,
  `key` varchar(100) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `value` json NOT NULL,
  `scope_type` varchar(10) COLLATE utf8mb4_0900_as_cs NOT NULL DEFAULT 'GLOBAL',
  `scope_id` binary(16) DEFAULT NULL,
  `valid_from` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `is_client_visible` tinyint(1) NOT NULL DEFAULT '0',
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  `reason` text COLLATE utf8mb4_0900_as_cs,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_organization_system_settings_version` (`key`,`scope_type`,`scope_id`,`valid_from`),
  KEY `fk_organization_system_settings_created_by` (`created_by`),
  CONSTRAINT `fk_organization_system_settings_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_organization_system_settings_scope` CHECK ((`scope_type` in (_utf8mb4'GLOBAL',_utf8mb4'SITE',_utf8mb4'ZONE',_utf8mb4'ROLE')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_organization_system_settings_no_update` BEFORE UPDATE ON `organization_system_settings` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'organization_system_settings : aucune modification (versionnement, BR-ADM-015) ; insérer une nouvelle version.';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_organization_system_settings_no_delete` BEFORE DELETE ON `organization_system_settings` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'organization_system_settings : suppression physique interdite (versionnement, BR-ADM-015).';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `organization_team_memberships`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `organization_team_memberships` (
  `id` binary(16) NOT NULL,
  `team_id` binary(16) NOT NULL,
  `user_id` binary(16) NOT NULL,
  `valid_from` datetime(6) NOT NULL,
  `valid_to` datetime(6) DEFAULT NULL,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `updated_by` binary(16) DEFAULT NULL,
  `version` int NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`),
  KEY `ix_organization_team_memberships_user` (`user_id`,`valid_from`,`valid_to`),
  KEY `fk_organization_team_memberships_team` (`team_id`),
  KEY `fk_organization_team_memberships_created_by` (`created_by`),
  KEY `fk_organization_team_memberships_updated_by` (`updated_by`),
  CONSTRAINT `fk_organization_team_memberships_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_organization_team_memberships_team` FOREIGN KEY (`team_id`) REFERENCES `organization_teams` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_organization_team_memberships_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_organization_team_memberships_user` FOREIGN KEY (`user_id`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_organization_team_memberships_period` CHECK (((`valid_to` is null) or (`valid_to` > `valid_from`)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_organization_team_memberships_overlap_ins` BEFORE INSERT ON `organization_team_memberships` FOR EACH ROW BEGIN
  IF EXISTS (
    SELECT 1 FROM organization_team_memberships
    WHERE user_id = NEW.user_id
      AND id <> NEW.id
      AND valid_from < COALESCE(NEW.valid_to, '9999-12-31 23:59:59.999999')
      AND COALESCE(valid_to, '9999-12-31 23:59:59.999999') > NEW.valid_from
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'organization_team_memberships : périodes chevauchantes pour cet utilisateur (BR-ADM-014).';
  END IF;
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_organization_team_memberships_update_guard` BEFORE UPDATE ON `organization_team_memberships` FOR EACH ROW BEGIN
  IF NOT (
    NEW.team_id <=> OLD.team_id AND
    NEW.user_id <=> OLD.user_id AND
    NEW.valid_from <=> OLD.valid_from AND
    NEW.created_at <=> OLD.created_at AND
    NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'organization_team_memberships : seule la fermeture (valid_to) est modifiable.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM organization_team_memberships
    WHERE user_id = NEW.user_id
      AND id <> NEW.id
      AND valid_from < COALESCE(NEW.valid_to, '9999-12-31 23:59:59.999999')
      AND COALESCE(valid_to, '9999-12-31 23:59:59.999999') > NEW.valid_from
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'organization_team_memberships : périodes chevauchantes pour cet utilisateur (BR-ADM-014).';
  END IF;
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_organization_team_memberships_no_delete` BEFORE DELETE ON `organization_team_memberships` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'organization_team_memberships : suppression physique interdite (INV-ADM-04) ; fermer par valid_to.';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `organization_teams`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `organization_teams` (
  `id` binary(16) NOT NULL,
  `code` varchar(40) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `name` varchar(200) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `manager_user_id` binary(16) NOT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `updated_by` binary(16) DEFAULT NULL,
  `version` int NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_organization_teams_code` (`code`),
  KEY `fk_organization_teams_manager` (`manager_user_id`),
  KEY `fk_organization_teams_created_by` (`created_by`),
  KEY `fk_organization_teams_updated_by` (`updated_by`),
  CONSTRAINT `fk_organization_teams_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_organization_teams_manager` FOREIGN KEY (`manager_user_id`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_organization_teams_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_organization_teams_no_delete` BEFORE DELETE ON `organization_teams` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'organization_teams : suppression physique interdite (INV-GLO-03) ; utiliser is_active=false.';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `organization_zone_ancestors`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `organization_zone_ancestors` (
  `zone_id` binary(16) NOT NULL,
  `ancestor_id` binary(16) NOT NULL,
  `depth` smallint NOT NULL,
  PRIMARY KEY (`zone_id`,`ancestor_id`),
  KEY `ix_organization_zone_ancestors_ancestor` (`ancestor_id`),
  CONSTRAINT `fk_organization_zone_ancestors_ancestor` FOREIGN KEY (`ancestor_id`) REFERENCES `organization_zones` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_organization_zone_ancestors_zone` FOREIGN KEY (`zone_id`) REFERENCES `organization_zones` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `organization_zones`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `organization_zones` (
  `id` binary(16) NOT NULL,
  `parent_id` binary(16) DEFAULT NULL,
  `level` varchar(20) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `code` varchar(40) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `name` varchar(200) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `depth` smallint NOT NULL,
  `geofence_lat` decimal(9,6) DEFAULT NULL,
  `geofence_lng` decimal(9,6) DEFAULT NULL,
  `geofence_radius_m` decimal(8,1) DEFAULT NULL,
  `max_gps_accuracy_m` decimal(8,1) DEFAULT '150.0',
  `is_active` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `updated_by` binary(16) DEFAULT NULL,
  `version` int NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_organization_zones_code` (`code`),
  KEY `ix_organization_zones_parent` (`parent_id`),
  KEY `fk_organization_zones_created_by` (`created_by`),
  KEY `fk_organization_zones_updated_by` (`updated_by`),
  CONSTRAINT `fk_organization_zones_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_organization_zones_parent` FOREIGN KEY (`parent_id`) REFERENCES `organization_zones` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_organization_zones_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_organization_zones_geofence` CHECK ((((`geofence_lat` is null) and (`geofence_lng` is null) and (`geofence_radius_m` is null)) or ((`geofence_lat` is not null) and (`geofence_lng` is not null) and (`geofence_radius_m` is not null)))),
  CONSTRAINT `ck_organization_zones_level` CHECK ((`level` in (_utf8mb4'PAYS',_utf8mb4'REGION',_utf8mb4'VILLE',_utf8mb4'MARCHE',_utf8mb4'QUARTIER',_utf8mb4'SECTEUR'))),
  CONSTRAINT `ck_organization_zones_radius` CHECK (((`geofence_radius_m` is null) or (`geofence_radius_m` between 50 and 5000)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_organization_zones_no_delete` BEFORE DELETE ON `organization_zones` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'organization_zones : suppression physique interdite (INV-GLO-03) ; utiliser is_active=false.';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `platform_document_sequences`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `platform_document_sequences` (
  `doc_type` varchar(10) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `site_id` binary(16) NOT NULL,
  `year` smallint NOT NULL,
  `next_value` int NOT NULL DEFAULT '1',
  PRIMARY KEY (`doc_type`,`site_id`,`year`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `platform_domain_events`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `platform_domain_events` (
  `seq` bigint unsigned NOT NULL AUTO_INCREMENT,
  `event_id` binary(16) NOT NULL,
  `event_type` varchar(80) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `event_version` smallint NOT NULL DEFAULT '1',
  `producer_module` varchar(40) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `aggregate_type` varchar(40) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `aggregate_id` binary(16) NOT NULL,
  `occurred_at` datetime(6) NOT NULL,
  `recorded_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `payload` json NOT NULL,
  `command_id` binary(16) DEFAULT NULL,
  `correlation_id` binary(16) DEFAULT NULL,
  `causation_id` binary(16) DEFAULT NULL,
  PRIMARY KEY (`seq`),
  UNIQUE KEY `uq_platform_domain_events_event_id` (`event_id`),
  KEY `ix_platform_domain_events_type_seq` (`event_type`,`seq`),
  KEY `ix_platform_domain_events_aggregate` (`aggregate_type`,`aggregate_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_platform_domain_events_no_update` BEFORE UPDATE ON `platform_domain_events` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'platform_domain_events : aucune modification (immuable, ADR-011).';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_platform_domain_events_no_delete` BEFORE DELETE ON `platform_domain_events` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'platform_domain_events : suppression physique interdite (INV-GLO-03).';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `platform_event_consumer_marks`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `platform_event_consumer_marks` (
  `consumer_name` varchar(80) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `event_id` binary(16) NOT NULL,
  `processed_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`consumer_name`,`event_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `platform_event_consumer_offsets`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `platform_event_consumer_offsets` (
  `consumer_name` varchar(80) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `last_seq` bigint NOT NULL DEFAULT '0',
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `last_error` text COLLATE utf8mb4_0900_as_cs,
  PRIMARY KEY (`consumer_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `platform_jobs`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `platform_jobs` (
  `id` binary(16) NOT NULL,
  `job_type` varchar(80) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `payload` json NOT NULL,
  `status` varchar(10) COLLATE utf8mb4_0900_as_cs NOT NULL DEFAULT 'PENDING',
  `run_at` datetime(6) NOT NULL,
  `attempts` smallint NOT NULL DEFAULT '0',
  `max_attempts` smallint NOT NULL DEFAULT '5',
  `last_error` text COLLATE utf8mb4_0900_as_cs,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `completed_at` datetime(6) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_platform_jobs_poll` (`status`,`run_at`),
  CONSTRAINT `ck_platform_jobs_status` CHECK ((`status` in (_utf8mb4'PENDING',_utf8mb4'DONE',_utf8mb4'FAILED')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `pricing_commercial_campaigns`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `pricing_commercial_campaigns` (
  `id` binary(16) NOT NULL,
  `code` varchar(40) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `name` varchar(200) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `valid_from` datetime(6) NOT NULL,
  `valid_to` datetime(6) NOT NULL,
  `status` varchar(10) COLLATE utf8mb4_0900_as_cs NOT NULL DEFAULT 'DRAFT',
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `updated_by` binary(16) DEFAULT NULL,
  `version` int NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_pricing_commercial_campaigns_code` (`code`),
  KEY `fk_pricing_commercial_campaigns_created_by` (`created_by`),
  KEY `fk_pricing_commercial_campaigns_updated_by` (`updated_by`),
  CONSTRAINT `fk_pricing_commercial_campaigns_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_pricing_commercial_campaigns_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_pricing_commercial_campaigns_period` CHECK ((`valid_to` > `valid_from`)),
  CONSTRAINT `ck_pricing_commercial_campaigns_status` CHECK ((`status` in (_utf8mb4'DRAFT',_utf8mb4'ACTIVE',_utf8mb4'CANCELLED')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_pricing_commercial_campaigns_no_delete` BEFORE DELETE ON `pricing_commercial_campaigns` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'pricing_commercial_campaigns : suppression physique interdite (INV-GLO-03) ; utiliser status=CANCELLED.';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `pricing_price_rules`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `pricing_price_rules` (
  `id` binary(16) NOT NULL,
  `code` varchar(40) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `version` int NOT NULL DEFAULT '1',
  `supersedes_rule_id` binary(16) DEFAULT NULL,
  `product_id` binary(16) NOT NULL,
  `unit_price_xaf` bigint NOT NULL,
  `pricing_unit_code` varchar(20) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `zone_id` binary(16) DEFAULT NULL,
  `site_id` binary(16) DEFAULT NULL,
  `customer_category_id` binary(16) DEFAULT NULL,
  `channel_code` varchar(20) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `min_quantity` decimal(14,3) DEFAULT NULL,
  `commercial_campaign_id` binary(16) DEFAULT NULL,
  `priority` int NOT NULL DEFAULT '0',
  `specificity` smallint NOT NULL DEFAULT '0',
  `valid_from` datetime(6) NOT NULL,
  `valid_to` datetime(6) DEFAULT NULL,
  `status` varchar(10) COLLATE utf8mb4_0900_as_cs NOT NULL DEFAULT 'DRAFT',
  `approved_by` binary(16) DEFAULT NULL,
  `approved_at` datetime(6) DEFAULT NULL,
  `notes` text COLLATE utf8mb4_0900_as_cs,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `updated_by` binary(16) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_pricing_price_rules_code_version` (`code`,`version`),
  KEY `ix_pricing_price_rules_product_status_from` (`product_id`,`status`,`valid_from`),
  KEY `ix_pricing_price_rules_zone` (`zone_id`),
  KEY `ix_pricing_price_rules_site` (`site_id`),
  KEY `fk_pricing_price_rules_supersedes` (`supersedes_rule_id`),
  KEY `fk_pricing_price_rules_pricing_unit` (`pricing_unit_code`),
  KEY `fk_pricing_price_rules_customer_category` (`customer_category_id`),
  KEY `fk_pricing_price_rules_channel` (`channel_code`),
  KEY `fk_pricing_price_rules_campaign` (`commercial_campaign_id`),
  KEY `fk_pricing_price_rules_approved_by` (`approved_by`),
  KEY `fk_pricing_price_rules_created_by` (`created_by`),
  KEY `fk_pricing_price_rules_updated_by` (`updated_by`),
  CONSTRAINT `fk_pricing_price_rules_approved_by` FOREIGN KEY (`approved_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_pricing_price_rules_campaign` FOREIGN KEY (`commercial_campaign_id`) REFERENCES `pricing_commercial_campaigns` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_pricing_price_rules_channel` FOREIGN KEY (`channel_code`) REFERENCES `catalog_sales_channels` (`code`) ON DELETE RESTRICT,
  CONSTRAINT `fk_pricing_price_rules_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_pricing_price_rules_customer_category` FOREIGN KEY (`customer_category_id`) REFERENCES `catalog_customer_categories` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_pricing_price_rules_pricing_unit` FOREIGN KEY (`pricing_unit_code`) REFERENCES `catalog_units` (`code`) ON DELETE RESTRICT,
  CONSTRAINT `fk_pricing_price_rules_product` FOREIGN KEY (`product_id`) REFERENCES `catalog_products` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_pricing_price_rules_site` FOREIGN KEY (`site_id`) REFERENCES `organization_sites` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_pricing_price_rules_supersedes` FOREIGN KEY (`supersedes_rule_id`) REFERENCES `pricing_price_rules` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_pricing_price_rules_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_pricing_price_rules_zone` FOREIGN KEY (`zone_id`) REFERENCES `organization_zones` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_pricing_price_rules_approved` CHECK ((((`status` in (_utf8mb4'ACTIVE',_utf8mb4'RETIRED')) and (`approved_by` is not null) and (`approved_at` is not null)) or (`status` in (_utf8mb4'DRAFT',_utf8mb4'CANCELLED')))),
  CONSTRAINT `ck_pricing_price_rules_min_quantity` CHECK (((`min_quantity` is null) or (`min_quantity` > 0))),
  CONSTRAINT `ck_pricing_price_rules_period` CHECK (((`valid_to` is null) or (`valid_to` > `valid_from`))),
  CONSTRAINT `ck_pricing_price_rules_price` CHECK ((`unit_price_xaf` > 0)),
  CONSTRAINT `ck_pricing_price_rules_status` CHECK ((`status` in (_utf8mb4'DRAFT',_utf8mb4'ACTIVE',_utf8mb4'RETIRED',_utf8mb4'CANCELLED')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_pricing_price_rules_update_guard` BEFORE UPDATE ON `pricing_price_rules` FOR EACH ROW BEGIN
  IF OLD.status IN ('ACTIVE', 'RETIRED') THEN
    IF NOT (
      NEW.code <=> OLD.code AND NEW.version <=> OLD.version AND
      NEW.supersedes_rule_id <=> OLD.supersedes_rule_id AND
      NEW.product_id <=> OLD.product_id AND NEW.unit_price_xaf <=> OLD.unit_price_xaf AND
      NEW.pricing_unit_code <=> OLD.pricing_unit_code AND NEW.zone_id <=> OLD.zone_id AND
      NEW.site_id <=> OLD.site_id AND NEW.customer_category_id <=> OLD.customer_category_id AND
      NEW.channel_code <=> OLD.channel_code AND NEW.min_quantity <=> OLD.min_quantity AND
      NEW.commercial_campaign_id <=> OLD.commercial_campaign_id AND
      NEW.priority <=> OLD.priority AND NEW.specificity <=> OLD.specificity AND
      NEW.valid_from <=> OLD.valid_from AND
      NEW.approved_by <=> OLD.approved_by AND NEW.approved_at <=> OLD.approved_at AND
      NEW.created_at <=> OLD.created_at AND NEW.created_by <=> OLD.created_by AND
      (NEW.valid_to <=> OLD.valid_to OR (NEW.valid_to IS NOT NULL AND (OLD.valid_to IS NULL OR NEW.valid_to < OLD.valid_to)))
    ) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'pricing_price_rules : règle active ou terminée immuable, sauf réduction de valid_to (BR-PRX-007).';
    END IF;
    IF NEW.status NOT IN ('ACTIVE', 'RETIRED') THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'pricing_price_rules : une règle active ou terminée ne redevient jamais brouillon.';
    END IF;
  END IF;
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_pricing_price_rules_no_delete` BEFORE DELETE ON `pricing_price_rules` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'pricing_price_rules : suppression physique interdite (INV-PRX-03).';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `procurement_goods_receipt_lines`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `procurement_goods_receipt_lines` (
  `id` binary(16) NOT NULL,
  `receipt_id` binary(16) NOT NULL,
  `po_line_id` binary(16) DEFAULT NULL,
  `product_id` binary(16) NOT NULL,
  `unit_code` varchar(20) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `qty_delivered_base` decimal(14,3) NOT NULL,
  `qty_rejected_base` decimal(14,3) NOT NULL DEFAULT '0.000',
  `qty_accepted_base` decimal(14,3) GENERATED ALWAYS AS ((`qty_delivered_base` - `qty_rejected_base`)) STORED,
  `over_receipt_qty_base` decimal(14,3) NOT NULL DEFAULT '0.000',
  `rejection_reason_code_id` binary(16) DEFAULT NULL,
  `unit_cost_xaf` bigint NOT NULL,
  `supplier_lot_ref` varchar(60) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `expiry_date` date DEFAULT NULL,
  `stock_lot_id` binary(16) DEFAULT NULL,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  KEY `ix_procurement_goods_receipt_lines_receipt` (`receipt_id`),
  KEY `ix_procurement_goods_receipt_lines_po_line` (`po_line_id`),
  KEY `fk_procurement_goods_receipt_lines_product` (`product_id`),
  KEY `fk_procurement_goods_receipt_lines_unit` (`unit_code`),
  KEY `fk_procurement_goods_receipt_lines_rejection_reason` (`rejection_reason_code_id`),
  KEY `fk_procurement_goods_receipt_lines_stock_lot` (`stock_lot_id`),
  CONSTRAINT `fk_procurement_goods_receipt_lines_po_line` FOREIGN KEY (`po_line_id`) REFERENCES `procurement_purchase_order_lines` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_procurement_goods_receipt_lines_product` FOREIGN KEY (`product_id`) REFERENCES `catalog_products` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_procurement_goods_receipt_lines_receipt` FOREIGN KEY (`receipt_id`) REFERENCES `procurement_goods_receipts` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_procurement_goods_receipt_lines_rejection_reason` FOREIGN KEY (`rejection_reason_code_id`) REFERENCES `catalog_reason_codes` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_procurement_goods_receipt_lines_stock_lot` FOREIGN KEY (`stock_lot_id`) REFERENCES `inventory_stock_lots` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_procurement_goods_receipt_lines_unit` FOREIGN KEY (`unit_code`) REFERENCES `catalog_units` (`code`) ON DELETE RESTRICT,
  CONSTRAINT `ck_procurement_goods_receipt_lines_cost` CHECK ((`unit_cost_xaf` >= 0)),
  CONSTRAINT `ck_procurement_goods_receipt_lines_qty` CHECK (((`qty_delivered_base` > 0) and (`qty_rejected_base` >= 0) and (`qty_rejected_base` <= `qty_delivered_base`) and (`over_receipt_qty_base` >= 0) and (`over_receipt_qty_base` <= (`qty_delivered_base` - `qty_rejected_base`)))),
  CONSTRAINT `ck_procurement_goods_receipt_lines_rejection` CHECK (((`qty_rejected_base` = 0) or (`rejection_reason_code_id` is not null)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_procurement_goods_receipt_lines_update_guard` BEFORE UPDATE ON `procurement_goods_receipt_lines` FOR EACH ROW BEGIN
  IF NOT (
    NEW.receipt_id <=> OLD.receipt_id AND
    NEW.po_line_id <=> OLD.po_line_id AND
    NEW.product_id <=> OLD.product_id AND
    NEW.unit_code <=> OLD.unit_code AND
    NEW.qty_delivered_base <=> OLD.qty_delivered_base AND
    NEW.qty_rejected_base <=> OLD.qty_rejected_base AND
    NEW.over_receipt_qty_base <=> OLD.over_receipt_qty_base AND
    NEW.rejection_reason_code_id <=> OLD.rejection_reason_code_id AND
    NEW.unit_cost_xaf <=> OLD.unit_cost_xaf AND
    NEW.supplier_lot_ref <=> OLD.supplier_lot_ref AND
    NEW.expiry_date <=> OLD.expiry_date AND
    NEW.created_at <=> OLD.created_at
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'procurement_goods_receipt_lines : ligne de réception immuable (seul le lot de stock se renseigne).';
  END IF;
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_procurement_goods_receipt_lines_no_delete` BEFORE DELETE ON `procurement_goods_receipt_lines` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'procurement_goods_receipt_lines : suppression physique interdite (INV-GLO-03).';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `procurement_goods_receipts`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `procurement_goods_receipts` (
  `id` binary(16) NOT NULL,
  `doc_number` varchar(40) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `local_ref` varchar(20) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `site_id` binary(16) NOT NULL,
  `purchase_order_id` binary(16) DEFAULT NULL,
  `supplier_id` binary(16) NOT NULL,
  `location_id` binary(16) NOT NULL,
  `received_by` binary(16) NOT NULL,
  `supplier_delivery_note_ref` varchar(60) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `observations` text COLLATE utf8mb4_0900_as_cs,
  `status` varchar(25) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `approval_request_id` binary(16) DEFAULT NULL,
  `total_accepted_value_xaf` bigint NOT NULL DEFAULT '0',
  `distinct_note_confirmed` tinyint(1) NOT NULL DEFAULT '0',
  `posted_note_key` varchar(100) COLLATE utf8mb4_0900_as_cs GENERATED ALWAYS AS ((case when ((`supplier_delivery_note_ref` is not null) and (`distinct_note_confirmed` = false) and (`status` in (_utf8mb4'POSTED',_utf8mb4'POSTED_PENDING_REVIEW',_utf8mb4'REVIEW_REJECTED',_utf8mb4'CANCELLATION_PENDING'))) then concat(hex(`supplier_id`),_utf8mb4':',`supplier_delivery_note_ref`) end)) STORED,
  `cancelled_at` datetime(6) DEFAULT NULL,
  `cancelled_by` binary(16) DEFAULT NULL,
  `cancel_reason_code_id` binary(16) DEFAULT NULL,
  `cancel_comment` text COLLATE utf8mb4_0900_as_cs,
  `cancel_approval_request_id` binary(16) DEFAULT NULL,
  `occurred_at` datetime(6) NOT NULL,
  `client_created_at` datetime(6) DEFAULT NULL,
  `received_at_server` datetime(6) DEFAULT NULL,
  `command_id` binary(16) DEFAULT NULL,
  `created_device_id` binary(16) DEFAULT NULL,
  `captured_offline` tinyint(1) NOT NULL DEFAULT '0',
  `clock_suspect` tinyint(1) NOT NULL DEFAULT '0',
  `backdated_reason` text COLLATE utf8mb4_0900_as_cs,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `updated_by` binary(16) DEFAULT NULL,
  `version` int NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_procurement_goods_receipts_doc_number` (`doc_number`),
  UNIQUE KEY `uq_procurement_goods_receipts_command` (`command_id`),
  UNIQUE KEY `uq_procurement_goods_receipts_device_ref` (`created_device_id`,`local_ref`),
  UNIQUE KEY `uq_procurement_goods_receipts_posted_note` (`posted_note_key`),
  KEY `ix_procurement_goods_receipts_order` (`purchase_order_id`),
  KEY `ix_procurement_goods_receipts_location` (`location_id`,`occurred_at`),
  KEY `ix_procurement_goods_receipts_supplier_note` (`supplier_id`,`supplier_delivery_note_ref`),
  KEY `ix_procurement_goods_receipts_status` (`status`,`site_id`),
  KEY `fk_procurement_goods_receipts_site` (`site_id`),
  KEY `fk_procurement_goods_receipts_received_by` (`received_by`),
  KEY `fk_procurement_goods_receipts_approval` (`approval_request_id`),
  KEY `fk_procurement_goods_receipts_cancelled_by` (`cancelled_by`),
  KEY `fk_procurement_goods_receipts_cancel_reason` (`cancel_reason_code_id`),
  KEY `fk_procurement_goods_receipts_cancel_approval` (`cancel_approval_request_id`),
  KEY `fk_procurement_goods_receipts_created_by` (`created_by`),
  KEY `fk_procurement_goods_receipts_updated_by` (`updated_by`),
  CONSTRAINT `fk_procurement_goods_receipts_approval` FOREIGN KEY (`approval_request_id`) REFERENCES `approvals_approval_requests` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_procurement_goods_receipts_cancel_approval` FOREIGN KEY (`cancel_approval_request_id`) REFERENCES `approvals_approval_requests` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_procurement_goods_receipts_cancel_reason` FOREIGN KEY (`cancel_reason_code_id`) REFERENCES `catalog_reason_codes` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_procurement_goods_receipts_cancelled_by` FOREIGN KEY (`cancelled_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_procurement_goods_receipts_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_procurement_goods_receipts_created_device` FOREIGN KEY (`created_device_id`) REFERENCES `identity_devices` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_procurement_goods_receipts_location` FOREIGN KEY (`location_id`) REFERENCES `organization_locations` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_procurement_goods_receipts_order` FOREIGN KEY (`purchase_order_id`) REFERENCES `procurement_purchase_orders` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_procurement_goods_receipts_received_by` FOREIGN KEY (`received_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_procurement_goods_receipts_site` FOREIGN KEY (`site_id`) REFERENCES `organization_sites` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_procurement_goods_receipts_supplier` FOREIGN KEY (`supplier_id`) REFERENCES `procurement_suppliers` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_procurement_goods_receipts_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_procurement_goods_receipts_cancel` CHECK ((((`status` = _utf8mb4'CANCELLED') and (`cancelled_at` is not null) and (`cancelled_by` is not null)) or ((`status` <> _utf8mb4'CANCELLED') and (`cancelled_at` is null) and (`cancelled_by` is null) and (`cancel_reason_code_id` is null) and (`cancel_comment` is null)))),
  CONSTRAINT `ck_procurement_goods_receipts_status` CHECK ((`status` in (_utf8mb4'POSTED',_utf8mb4'POSTED_PENDING_REVIEW',_utf8mb4'REVIEW_REJECTED',_utf8mb4'QUARANTINED',_utf8mb4'REJECTED',_utf8mb4'CANCELLATION_PENDING',_utf8mb4'CANCELLED'))),
  CONSTRAINT `ck_procurement_goods_receipts_value` CHECK ((`total_accepted_value_xaf` >= 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_procurement_goods_receipts_update_guard` BEFORE UPDATE ON `procurement_goods_receipts` FOR EACH ROW BEGIN
  IF NOT (
    NEW.doc_number <=> OLD.doc_number AND
    NEW.site_id <=> OLD.site_id AND
    NEW.purchase_order_id <=> OLD.purchase_order_id AND
    NEW.supplier_id <=> OLD.supplier_id AND
    NEW.location_id <=> OLD.location_id AND
    NEW.received_by <=> OLD.received_by AND
    NEW.supplier_delivery_note_ref <=> OLD.supplier_delivery_note_ref AND
    NEW.observations <=> OLD.observations AND
    NEW.total_accepted_value_xaf <=> OLD.total_accepted_value_xaf AND
    NEW.occurred_at <=> OLD.occurred_at AND
    NEW.command_id <=> OLD.command_id AND
    NEW.created_device_id <=> OLD.created_device_id AND
    NEW.created_at <=> OLD.created_at AND
    NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'procurement_goods_receipts : réception non modifiable ; seuls statut, validation et annulation évoluent.';
  END IF;
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_procurement_goods_receipts_no_delete` BEFORE DELETE ON `procurement_goods_receipts` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'procurement_goods_receipts : suppression physique interdite (INV-GLO-03) ; annuler par contre-écriture.';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `procurement_purchase_order_lines`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `procurement_purchase_order_lines` (
  `id` binary(16) NOT NULL,
  `order_id` binary(16) NOT NULL,
  `line_no` smallint NOT NULL,
  `request_line_id` binary(16) DEFAULT NULL,
  `product_id` binary(16) NOT NULL,
  `unit_code` varchar(20) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `ordered_qty_base` decimal(14,3) NOT NULL,
  `unit_price_xaf` bigint NOT NULL,
  `line_total_xaf` bigint NOT NULL,
  `accepted_qty_base` decimal(14,3) NOT NULL DEFAULT '0.000',
  `invoiced_qty_base` decimal(14,3) NOT NULL DEFAULT '0.000',
  `closed_qty_base` decimal(14,3) NOT NULL DEFAULT '0.000',
  `excess_qty_base` decimal(14,3) NOT NULL DEFAULT '0.000',
  `status` varchar(12) COLLATE utf8mb4_0900_as_cs NOT NULL DEFAULT 'OPEN',
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_procurement_purchase_order_lines_line_no` (`order_id`,`line_no`),
  KEY `ix_procurement_purchase_order_lines_request_line` (`request_line_id`),
  KEY `ix_procurement_purchase_order_lines_product` (`product_id`),
  KEY `fk_procurement_purchase_order_lines_unit` (`unit_code`),
  CONSTRAINT `fk_procurement_purchase_order_lines_order` FOREIGN KEY (`order_id`) REFERENCES `procurement_purchase_orders` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_procurement_purchase_order_lines_product` FOREIGN KEY (`product_id`) REFERENCES `catalog_products` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_procurement_purchase_order_lines_request_line` FOREIGN KEY (`request_line_id`) REFERENCES `procurement_purchase_request_lines` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_procurement_purchase_order_lines_unit` FOREIGN KEY (`unit_code`) REFERENCES `catalog_units` (`code`) ON DELETE RESTRICT,
  CONSTRAINT `ck_procurement_purchase_order_lines_amounts` CHECK (((`ordered_qty_base` > 0) and (`unit_price_xaf` >= 0) and (`line_total_xaf` >= 0) and (`accepted_qty_base` >= 0) and (`invoiced_qty_base` >= 0) and (`closed_qty_base` >= 0) and (`excess_qty_base` >= 0))),
  CONSTRAINT `ck_procurement_purchase_order_lines_received` CHECK (((`accepted_qty_base` + `closed_qty_base`) <= (`ordered_qty_base` + `excess_qty_base`))),
  CONSTRAINT `ck_procurement_purchase_order_lines_status` CHECK ((`status` in (_utf8mb4'OPEN',_utf8mb4'RECEIVED',_utf8mb4'CLOSED',_utf8mb4'CANCELLED')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_procurement_purchase_order_lines_update_guard` BEFORE UPDATE ON `procurement_purchase_order_lines` FOR EACH ROW BEGIN
  IF NOT (
    NEW.order_id <=> OLD.order_id AND
    NEW.line_no <=> OLD.line_no AND
    NEW.request_line_id <=> OLD.request_line_id AND
    NEW.product_id <=> OLD.product_id AND
    NEW.unit_code <=> OLD.unit_code AND
    NEW.created_at <=> OLD.created_at
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'procurement_purchase_order_lines : produit et rattachement d''une ligne immuables.';
  END IF;
  IF (NEW.ordered_qty_base > OLD.ordered_qty_base OR NEW.unit_price_xaf > OLD.unit_price_xaf)
     AND (SELECT status FROM procurement_purchase_orders WHERE id = NEW.order_id)
         IN ('SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'procurement_purchase_order_lines : ligne d''un BC envoyé jamais augmentée (INV-APP-04) ; créer un nouveau BC.';
  END IF;
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_procurement_purchase_order_lines_no_delete` BEFORE DELETE ON `procurement_purchase_order_lines` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'procurement_purchase_order_lines : suppression physique interdite (INV-GLO-03) ; utiliser CANCELLED.';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `procurement_purchase_orders`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `procurement_purchase_orders` (
  `id` binary(16) NOT NULL,
  `doc_number` varchar(40) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `local_ref` varchar(20) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `site_id` binary(16) NOT NULL,
  `supplier_id` binary(16) NOT NULL,
  `delivery_location_id` binary(16) NOT NULL,
  `expected_delivery_date` date DEFAULT NULL,
  `total_xaf` bigint NOT NULL,
  `status` varchar(20) COLLATE utf8mb4_0900_as_cs NOT NULL DEFAULT 'DRAFT',
  `approval_request_id` binary(16) DEFAULT NULL,
  `approved_by` binary(16) DEFAULT NULL,
  `approved_at` datetime(6) DEFAULT NULL,
  `sent_at` datetime(6) DEFAULT NULL,
  `closed_reason` text COLLATE utf8mb4_0900_as_cs,
  `cancelled_at` datetime(6) DEFAULT NULL,
  `cancelled_by` binary(16) DEFAULT NULL,
  `cancel_reason_code_id` binary(16) DEFAULT NULL,
  `cancel_comment` text COLLATE utf8mb4_0900_as_cs,
  `cancel_approval_request_id` binary(16) DEFAULT NULL,
  `occurred_at` datetime(6) NOT NULL,
  `command_id` binary(16) DEFAULT NULL,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `updated_by` binary(16) DEFAULT NULL,
  `version` int NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_procurement_purchase_orders_doc_number` (`doc_number`),
  UNIQUE KEY `uq_procurement_purchase_orders_command` (`command_id`),
  KEY `ix_procurement_purchase_orders_supplier` (`supplier_id`,`status`),
  KEY `ix_procurement_purchase_orders_location` (`delivery_location_id`,`status`),
  KEY `fk_procurement_purchase_orders_site` (`site_id`),
  KEY `fk_procurement_purchase_orders_approval` (`approval_request_id`),
  KEY `fk_procurement_purchase_orders_approved_by` (`approved_by`),
  KEY `fk_procurement_purchase_orders_cancelled_by` (`cancelled_by`),
  KEY `fk_procurement_purchase_orders_cancel_reason` (`cancel_reason_code_id`),
  KEY `fk_procurement_purchase_orders_cancel_approval` (`cancel_approval_request_id`),
  KEY `fk_procurement_purchase_orders_created_by` (`created_by`),
  KEY `fk_procurement_purchase_orders_updated_by` (`updated_by`),
  CONSTRAINT `fk_procurement_purchase_orders_approval` FOREIGN KEY (`approval_request_id`) REFERENCES `approvals_approval_requests` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_procurement_purchase_orders_approved_by` FOREIGN KEY (`approved_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_procurement_purchase_orders_cancel_approval` FOREIGN KEY (`cancel_approval_request_id`) REFERENCES `approvals_approval_requests` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_procurement_purchase_orders_cancel_reason` FOREIGN KEY (`cancel_reason_code_id`) REFERENCES `catalog_reason_codes` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_procurement_purchase_orders_cancelled_by` FOREIGN KEY (`cancelled_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_procurement_purchase_orders_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_procurement_purchase_orders_location` FOREIGN KEY (`delivery_location_id`) REFERENCES `organization_locations` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_procurement_purchase_orders_site` FOREIGN KEY (`site_id`) REFERENCES `organization_sites` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_procurement_purchase_orders_supplier` FOREIGN KEY (`supplier_id`) REFERENCES `procurement_suppliers` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_procurement_purchase_orders_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_procurement_purchase_orders_cancel` CHECK ((((`status` = _utf8mb4'CANCELLED') and (`cancelled_at` is not null) and (`cancelled_by` is not null)) or ((`status` <> _utf8mb4'CANCELLED') and (`cancelled_at` is null) and (`cancelled_by` is null) and (`cancel_reason_code_id` is null) and (`cancel_comment` is null) and (`cancel_approval_request_id` is null)))),
  CONSTRAINT `ck_procurement_purchase_orders_sent` CHECK (((`status` not in (_utf8mb4'SENT',_utf8mb4'PARTIALLY_RECEIVED',_utf8mb4'RECEIVED',_utf8mb4'CLOSED')) or (`sent_at` is not null))),
  CONSTRAINT `ck_procurement_purchase_orders_status` CHECK ((`status` in (_utf8mb4'DRAFT',_utf8mb4'PENDING_APPROVAL',_utf8mb4'APPROVED',_utf8mb4'SENT',_utf8mb4'PARTIALLY_RECEIVED',_utf8mb4'RECEIVED',_utf8mb4'CLOSED',_utf8mb4'CANCELLED'))),
  CONSTRAINT `ck_procurement_purchase_orders_total` CHECK ((`total_xaf` >= 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_procurement_purchase_orders_update_guard` BEFORE UPDATE ON `procurement_purchase_orders` FOR EACH ROW BEGIN
  IF NOT (
    NEW.doc_number <=> OLD.doc_number AND
    NEW.site_id <=> OLD.site_id AND
    NEW.supplier_id <=> OLD.supplier_id AND
    NEW.delivery_location_id <=> OLD.delivery_location_id AND
    NEW.occurred_at <=> OLD.occurred_at AND
    NEW.command_id <=> OLD.command_id AND
    NEW.created_at <=> OLD.created_at AND
    NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'procurement_purchase_orders : fournisseur, livraison et numéro immuables ; créer un nouveau BC.';
  END IF;
  IF OLD.status <> 'DRAFT' AND NOT (
    NEW.total_xaf <=> OLD.total_xaf AND NEW.expected_delivery_date <=> OLD.expected_delivery_date
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'procurement_purchase_orders : BC approuvé ou envoyé non modifiable (BR-APP-006, INV-APP-04).';
  END IF;
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_procurement_purchase_orders_no_delete` BEFORE DELETE ON `procurement_purchase_orders` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'procurement_purchase_orders : suppression physique interdite (INV-GLO-03) ; utiliser CANCELLED.';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `procurement_purchase_request_lines`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `procurement_purchase_request_lines` (
  `id` binary(16) NOT NULL,
  `request_id` binary(16) NOT NULL,
  `product_id` binary(16) NOT NULL,
  `quantity_base` decimal(14,3) NOT NULL,
  `unit_code` varchar(20) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `quantity` decimal(14,3) NOT NULL,
  `estimated_unit_price_xaf` bigint DEFAULT NULL,
  `ordered_qty_base` decimal(14,3) NOT NULL DEFAULT '0.000',
  `notes` text COLLATE utf8mb4_0900_as_cs,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  KEY `ix_procurement_purchase_request_lines_request` (`request_id`),
  KEY `fk_procurement_purchase_request_lines_product` (`product_id`),
  KEY `fk_procurement_purchase_request_lines_unit` (`unit_code`),
  CONSTRAINT `fk_procurement_purchase_request_lines_product` FOREIGN KEY (`product_id`) REFERENCES `catalog_products` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_procurement_purchase_request_lines_request` FOREIGN KEY (`request_id`) REFERENCES `procurement_purchase_requests` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_procurement_purchase_request_lines_unit` FOREIGN KEY (`unit_code`) REFERENCES `catalog_units` (`code`) ON DELETE RESTRICT,
  CONSTRAINT `ck_procurement_purchase_request_lines_price` CHECK (((`estimated_unit_price_xaf` is null) or (`estimated_unit_price_xaf` >= 0))),
  CONSTRAINT `ck_procurement_purchase_request_lines_qty` CHECK (((`quantity_base` > 0) and (`quantity` > 0) and (`ordered_qty_base` >= 0) and (`ordered_qty_base` <= `quantity_base`)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_procurement_purchase_request_lines_update_guard` BEFORE UPDATE ON `procurement_purchase_request_lines` FOR EACH ROW BEGIN
  IF NOT (
    NEW.request_id <=> OLD.request_id AND
    NEW.product_id <=> OLD.product_id AND
    NEW.quantity_base <=> OLD.quantity_base AND
    NEW.unit_code <=> OLD.unit_code AND
    NEW.quantity <=> OLD.quantity AND
    NEW.estimated_unit_price_xaf <=> OLD.estimated_unit_price_xaf AND
    NEW.notes <=> OLD.notes AND
    NEW.created_at <=> OLD.created_at
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'procurement_purchase_request_lines : seule la quantité commandée évolue (BR-APP-002, BR-APP-004).';
  END IF;
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_procurement_purchase_request_lines_no_delete` BEFORE DELETE ON `procurement_purchase_request_lines` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'procurement_purchase_request_lines : suppression physique interdite (INV-GLO-03).';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `procurement_purchase_requests`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `procurement_purchase_requests` (
  `id` binary(16) NOT NULL,
  `doc_number` varchar(40) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `local_ref` varchar(20) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `site_id` binary(16) NOT NULL,
  `requested_by` binary(16) NOT NULL,
  `needed_by_date` date DEFAULT NULL,
  `justification` text COLLATE utf8mb4_0900_as_cs NOT NULL,
  `estimated_total_xaf` bigint NOT NULL DEFAULT '0',
  `status` varchar(20) COLLATE utf8mb4_0900_as_cs NOT NULL DEFAULT 'SUBMITTED',
  `approval_request_id` binary(16) DEFAULT NULL,
  `occurred_at` datetime(6) NOT NULL,
  `client_created_at` datetime(6) DEFAULT NULL,
  `received_at_server` datetime(6) DEFAULT NULL,
  `command_id` binary(16) DEFAULT NULL,
  `created_device_id` binary(16) DEFAULT NULL,
  `captured_offline` tinyint(1) NOT NULL DEFAULT '0',
  `clock_suspect` tinyint(1) NOT NULL DEFAULT '0',
  `backdated_reason` text COLLATE utf8mb4_0900_as_cs,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `updated_by` binary(16) DEFAULT NULL,
  `version` int NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_procurement_purchase_requests_doc_number` (`doc_number`),
  UNIQUE KEY `uq_procurement_purchase_requests_command` (`command_id`),
  UNIQUE KEY `uq_procurement_purchase_requests_device_ref` (`created_device_id`,`local_ref`),
  KEY `ix_procurement_purchase_requests_requested_by` (`requested_by`,`occurred_at`),
  KEY `ix_procurement_purchase_requests_status` (`status`,`site_id`),
  KEY `fk_procurement_purchase_requests_site` (`site_id`),
  KEY `fk_procurement_purchase_requests_approval` (`approval_request_id`),
  KEY `fk_procurement_purchase_requests_created_by` (`created_by`),
  KEY `fk_procurement_purchase_requests_updated_by` (`updated_by`),
  CONSTRAINT `fk_procurement_purchase_requests_approval` FOREIGN KEY (`approval_request_id`) REFERENCES `approvals_approval_requests` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_procurement_purchase_requests_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_procurement_purchase_requests_created_device` FOREIGN KEY (`created_device_id`) REFERENCES `identity_devices` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_procurement_purchase_requests_requested_by` FOREIGN KEY (`requested_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_procurement_purchase_requests_site` FOREIGN KEY (`site_id`) REFERENCES `organization_sites` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_procurement_purchase_requests_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_procurement_purchase_requests_status` CHECK ((`status` in (_utf8mb4'SUBMITTED',_utf8mb4'APPROVED',_utf8mb4'REJECTED',_utf8mb4'CANCELLED',_utf8mb4'PARTIALLY_ORDERED',_utf8mb4'ORDERED',_utf8mb4'CLOSED'))),
  CONSTRAINT `ck_procurement_purchase_requests_total` CHECK ((`estimated_total_xaf` >= 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_procurement_purchase_requests_update_guard` BEFORE UPDATE ON `procurement_purchase_requests` FOR EACH ROW BEGIN
  IF NOT (
    NEW.doc_number <=> OLD.doc_number AND
    NEW.site_id <=> OLD.site_id AND
    NEW.requested_by <=> OLD.requested_by AND
    NEW.needed_by_date <=> OLD.needed_by_date AND
    NEW.justification <=> OLD.justification AND
    NEW.estimated_total_xaf <=> OLD.estimated_total_xaf AND
    NEW.occurred_at <=> OLD.occurred_at AND
    NEW.command_id <=> OLD.command_id AND
    NEW.created_device_id <=> OLD.created_device_id AND
    NEW.created_at <=> OLD.created_at AND
    NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'procurement_purchase_requests : demande soumise non modifiable ; l''annuler et en soumettre une nouvelle (BR-APP-002).';
  END IF;
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_procurement_purchase_requests_no_delete` BEFORE DELETE ON `procurement_purchase_requests` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'procurement_purchase_requests : suppression physique interdite (INV-GLO-03) ; utiliser CANCELLED.';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `procurement_suppliers`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `procurement_suppliers` (
  `id` binary(16) NOT NULL,
  `code` varchar(40) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `name` varchar(200) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `supplied_categories` json NOT NULL,
  `contact_name` varchar(200) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `phone` varchar(20) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `email` varchar(200) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `address` text COLLATE utf8mb4_0900_as_cs,
  `tax_id` varchar(40) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `payment_terms_days` smallint DEFAULT NULL,
  `status` varchar(10) COLLATE utf8mb4_0900_as_cs NOT NULL DEFAULT 'ACTIVE',
  `notes` text COLLATE utf8mb4_0900_as_cs,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `updated_by` binary(16) DEFAULT NULL,
  `version` int NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_procurement_suppliers_code` (`code`),
  KEY `fk_procurement_suppliers_created_by` (`created_by`),
  KEY `fk_procurement_suppliers_updated_by` (`updated_by`),
  FULLTEXT KEY `ftx_procurement_suppliers_name` (`name`) /*!50100 WITH PARSER `ngram` */ ,
  CONSTRAINT `fk_procurement_suppliers_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_procurement_suppliers_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_procurement_suppliers_payment_terms` CHECK (((`payment_terms_days` is null) or (`payment_terms_days` >= 0))),
  CONSTRAINT `ck_procurement_suppliers_status` CHECK ((`status` in (_utf8mb4'ACTIVE',_utf8mb4'INACTIVE')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_procurement_suppliers_no_delete` BEFORE DELETE ON `procurement_suppliers` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'procurement_suppliers : suppression physique interdite (INV-GLO-03) ; utiliser status=INACTIVE.';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `production_egg_collection_lines`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `production_egg_collection_lines` (
  `id` binary(16) NOT NULL,
  `collection_id` binary(16) NOT NULL,
  `product_id` binary(16) NOT NULL,
  `quantity` int NOT NULL,
  `unit_cost_xaf` bigint NOT NULL DEFAULT '0',
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_production_egg_collection_lines_grade` (`collection_id`,`product_id`),
  KEY `fk_production_egg_collection_lines_product` (`product_id`),
  CONSTRAINT `fk_production_egg_collection_lines_collection` FOREIGN KEY (`collection_id`) REFERENCES `production_egg_collections` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_production_egg_collection_lines_product` FOREIGN KEY (`product_id`) REFERENCES `catalog_products` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_production_egg_collection_lines_qty` CHECK (((`quantity` > 0) and (`unit_cost_xaf` >= 0)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_production_egg_collection_lines_no_update` BEFORE UPDATE ON `production_egg_collection_lines` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_egg_collection_lines : ligne immuable.';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_production_egg_collection_lines_no_delete` BEFORE DELETE ON `production_egg_collection_lines` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_egg_collection_lines : suppression physique interdite (INV-GLO-03).';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `production_egg_collections`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `production_egg_collections` (
  `id` binary(16) NOT NULL,
  `doc_number` varchar(40) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `production_lot_id` binary(16) NOT NULL,
  `site_id` binary(16) NOT NULL,
  `collection_date` date NOT NULL,
  `storage_location_id` binary(16) NOT NULL,
  `stock_lot_id` binary(16) NOT NULL,
  `hatching_product_id` binary(16) DEFAULT NULL,
  `collected_qty` int NOT NULL,
  `broken_qty` int NOT NULL DEFAULT '0',
  `nonconforming_qty` int NOT NULL DEFAULT '0',
  `marketable_qty` int NOT NULL,
  `hatching_qty` int NOT NULL DEFAULT '0',
  `standard_value_xaf` bigint NOT NULL DEFAULT '0',
  `status` varchar(15) COLLATE utf8mb4_0900_as_cs NOT NULL DEFAULT 'RECORDED',
  `cancelled_at` datetime(6) DEFAULT NULL,
  `cancelled_by` binary(16) DEFAULT NULL,
  `cancel_reason_code_id` binary(16) DEFAULT NULL,
  `cancel_comment` text COLLATE utf8mb4_0900_as_cs,
  `cancel_approval_request_id` binary(16) DEFAULT NULL,
  `occurred_at` datetime(6) NOT NULL,
  `client_created_at` datetime(6) DEFAULT NULL,
  `received_at_server` datetime(6) DEFAULT NULL,
  `command_id` binary(16) DEFAULT NULL,
  `created_device_id` binary(16) DEFAULT NULL,
  `captured_offline` tinyint(1) NOT NULL DEFAULT '0',
  `clock_suspect` tinyint(1) NOT NULL DEFAULT '0',
  `backdated_reason` text COLLATE utf8mb4_0900_as_cs,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `updated_by` binary(16) DEFAULT NULL,
  `version` int NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_production_egg_collections_doc_number` (`doc_number`),
  UNIQUE KEY `uq_production_egg_collections_stock_lot` (`stock_lot_id`),
  UNIQUE KEY `uq_production_egg_collections_command` (`command_id`),
  KEY `ix_production_egg_collections_lot_date` (`production_lot_id`,`collection_date`),
  KEY `ix_production_egg_collections_site_date` (`site_id`,`collection_date`),
  KEY `fk_production_egg_collections_location` (`storage_location_id`),
  KEY `fk_production_egg_collections_hatching_product` (`hatching_product_id`),
  KEY `fk_production_egg_collections_cancelled_by` (`cancelled_by`),
  KEY `fk_production_egg_collections_device` (`created_device_id`),
  KEY `fk_production_egg_collections_created_by` (`created_by`),
  CONSTRAINT `fk_production_egg_collections_cancelled_by` FOREIGN KEY (`cancelled_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_production_egg_collections_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_production_egg_collections_device` FOREIGN KEY (`created_device_id`) REFERENCES `identity_devices` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_production_egg_collections_hatching_product` FOREIGN KEY (`hatching_product_id`) REFERENCES `catalog_products` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_production_egg_collections_location` FOREIGN KEY (`storage_location_id`) REFERENCES `organization_locations` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_production_egg_collections_lot` FOREIGN KEY (`production_lot_id`) REFERENCES `production_production_lots` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_production_egg_collections_site` FOREIGN KEY (`site_id`) REFERENCES `organization_sites` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_production_egg_collections_stock_lot` FOREIGN KEY (`stock_lot_id`) REFERENCES `inventory_stock_lots` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_production_egg_collections_balance` CHECK (((`collected_qty` = (((`broken_qty` + `nonconforming_qty`) + `marketable_qty`) + `hatching_qty`)) and (`collected_qty` >= 0) and (`broken_qty` >= 0) and (`nonconforming_qty` >= 0) and (`marketable_qty` >= 0) and (`hatching_qty` >= 0))),
  CONSTRAINT `ck_production_egg_collections_cancel` CHECK ((((`status` = _utf8mb4'CANCELLED') and (`cancelled_at` is not null) and (`cancelled_by` is not null)) or ((`status` <> _utf8mb4'CANCELLED') and (`cancelled_at` is null) and (`cancelled_by` is null) and (`cancel_reason_code_id` is null) and (`cancel_comment` is null)))),
  CONSTRAINT `ck_production_egg_collections_hatching` CHECK (((`hatching_qty` = 0) or (`hatching_product_id` is not null))),
  CONSTRAINT `ck_production_egg_collections_status` CHECK ((`status` in (_utf8mb4'RECORDED',_utf8mb4'CANCELLED')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_production_egg_collections_update_guard` BEFORE UPDATE ON `production_egg_collections` FOR EACH ROW BEGIN
  IF NOT (
    NEW.production_lot_id <=> OLD.production_lot_id AND NEW.collection_date <=> OLD.collection_date AND
    NEW.collected_qty <=> OLD.collected_qty AND NEW.broken_qty <=> OLD.broken_qty AND
    NEW.nonconforming_qty <=> OLD.nonconforming_qty AND NEW.marketable_qty <=> OLD.marketable_qty AND
    NEW.hatching_qty <=> OLD.hatching_qty AND NEW.standard_value_xaf <=> OLD.standard_value_xaf AND
    NEW.occurred_at <=> OLD.occurred_at AND NEW.command_id <=> OLD.command_id AND NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_egg_collections : collecte non modifiable ; annuler puis ressaisir (BR-OEU-004).';
  END IF;
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_production_egg_collections_no_delete` BEFORE DELETE ON `production_egg_collections` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_egg_collections : suppression physique interdite (INV-GLO-03).';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `production_incubation_batches`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `production_incubation_batches` (
  `id` binary(16) NOT NULL,
  `batch_code` varchar(40) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `stock_lot_id` binary(16) NOT NULL,
  `site_id` binary(16) NOT NULL,
  `species` varchar(20) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `egg_product_id` binary(16) NOT NULL,
  `chick_product_id` binary(16) NOT NULL,
  `incubator_location_id` binary(16) NOT NULL,
  `hatcher_location_id` binary(16) DEFAULT NULL,
  `egg_source` varchar(10) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `eggs_set_qty` int NOT NULL,
  `set_at` datetime(6) NOT NULL,
  `expected_candling_date` date DEFAULT NULL,
  `expected_transfer_date` date DEFAULT NULL,
  `expected_hatch_date` date DEFAULT NULL,
  `infertile_qty` int NOT NULL DEFAULT '0',
  `early_dead_qty` int NOT NULL DEFAULT '0',
  `accidental_loss_qty` int NOT NULL DEFAULT '0',
  `transferred_qty` int NOT NULL DEFAULT '0',
  `hatched_viable_qty` int NOT NULL DEFAULT '0',
  `hatched_nonviable_qty` int NOT NULL DEFAULT '0',
  `unhatched_qty` int NOT NULL DEFAULT '0',
  `status` varchar(15) COLLATE utf8mb4_0900_as_cs NOT NULL DEFAULT 'INCUBATING',
  `hatch_rate` decimal(5,4) DEFAULT NULL,
  `cancelled_at` datetime(6) DEFAULT NULL,
  `cancelled_by` binary(16) DEFAULT NULL,
  `cancel_reason_code_id` binary(16) DEFAULT NULL,
  `cancel_comment` text COLLATE utf8mb4_0900_as_cs,
  `cancel_approval_request_id` binary(16) DEFAULT NULL,
  `occurred_at` datetime(6) NOT NULL,
  `client_created_at` datetime(6) DEFAULT NULL,
  `received_at_server` datetime(6) DEFAULT NULL,
  `command_id` binary(16) DEFAULT NULL,
  `created_device_id` binary(16) DEFAULT NULL,
  `captured_offline` tinyint(1) NOT NULL DEFAULT '0',
  `clock_suspect` tinyint(1) NOT NULL DEFAULT '0',
  `backdated_reason` text COLLATE utf8mb4_0900_as_cs,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `updated_by` binary(16) DEFAULT NULL,
  `version` int NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_production_incubation_batches_code` (`batch_code`),
  UNIQUE KEY `uq_production_incubation_batches_stock_lot` (`stock_lot_id`),
  UNIQUE KEY `uq_production_incubation_batches_command` (`command_id`),
  KEY `ix_production_incubation_batches_site_status` (`site_id`,`status`),
  KEY `fk_production_incubation_batches_egg_product` (`egg_product_id`),
  KEY `fk_production_incubation_batches_chick_product` (`chick_product_id`),
  KEY `fk_production_incubation_batches_incubator` (`incubator_location_id`),
  KEY `fk_production_incubation_batches_hatcher` (`hatcher_location_id`),
  KEY `fk_production_incubation_batches_cancelled_by` (`cancelled_by`),
  KEY `fk_production_incubation_batches_device` (`created_device_id`),
  KEY `fk_production_incubation_batches_created_by` (`created_by`),
  CONSTRAINT `fk_production_incubation_batches_cancelled_by` FOREIGN KEY (`cancelled_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_production_incubation_batches_chick_product` FOREIGN KEY (`chick_product_id`) REFERENCES `catalog_products` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_production_incubation_batches_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_production_incubation_batches_device` FOREIGN KEY (`created_device_id`) REFERENCES `identity_devices` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_production_incubation_batches_egg_product` FOREIGN KEY (`egg_product_id`) REFERENCES `catalog_products` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_production_incubation_batches_hatcher` FOREIGN KEY (`hatcher_location_id`) REFERENCES `organization_locations` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_production_incubation_batches_incubator` FOREIGN KEY (`incubator_location_id`) REFERENCES `organization_locations` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_production_incubation_batches_site` FOREIGN KEY (`site_id`) REFERENCES `organization_sites` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_production_incubation_batches_stock_lot` FOREIGN KEY (`stock_lot_id`) REFERENCES `inventory_stock_lots` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_production_incubation_batches_balance` CHECK (((`status` <> _utf8mb4'CLOSED') or (`eggs_set_qty` = (((((`infertile_qty` + `early_dead_qty`) + `accidental_loss_qty`) + `unhatched_qty`) + `hatched_viable_qty`) + `hatched_nonviable_qty`)))),
  CONSTRAINT `ck_production_incubation_batches_cancel` CHECK ((((`status` = _utf8mb4'CANCELLED') and (`cancelled_at` is not null) and (`cancelled_by` is not null)) or ((`status` <> _utf8mb4'CANCELLED') and (`cancelled_at` is null) and (`cancelled_by` is null) and (`cancel_reason_code_id` is null) and (`cancel_comment` is null)))),
  CONSTRAINT `ck_production_incubation_batches_counters` CHECK (((`eggs_set_qty` > 0) and (`infertile_qty` >= 0) and (`early_dead_qty` >= 0) and (`accidental_loss_qty` >= 0) and (`transferred_qty` >= 0) and (`hatched_viable_qty` >= 0) and (`hatched_nonviable_qty` >= 0) and (`unhatched_qty` >= 0))),
  CONSTRAINT `ck_production_incubation_batches_source` CHECK ((`egg_source` in (_utf8mb4'INTERNAL',_utf8mb4'PURCHASED'))),
  CONSTRAINT `ck_production_incubation_batches_status` CHECK ((`status` in (_utf8mb4'INCUBATING',_utf8mb4'IN_HATCHER',_utf8mb4'CLOSED',_utf8mb4'CANCELLED')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_production_incubation_batches_update_guard` BEFORE UPDATE ON `production_incubation_batches` FOR EACH ROW BEGIN
  IF NOT (
    NEW.batch_code <=> OLD.batch_code AND NEW.stock_lot_id <=> OLD.stock_lot_id AND NEW.site_id <=> OLD.site_id AND
    NEW.eggs_set_qty <=> OLD.eggs_set_qty AND NEW.set_at <=> OLD.set_at AND
    NEW.egg_product_id <=> OLD.egg_product_id AND NEW.chick_product_id <=> OLD.chick_product_id AND
    NEW.command_id <=> OLD.command_id AND NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_incubation_batches : œufs incubés figés au démarrage (BR-INC-002).';
  END IF;
  IF OLD.status IN ('CLOSED', 'CANCELLED') AND NOT (NEW.status <=> OLD.status) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_incubation_batches : un lot d''incubation clos ne change plus de statut.';
  END IF;
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_production_incubation_batches_no_delete` BEFORE DELETE ON `production_incubation_batches` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_incubation_batches : suppression physique interdite (INV-GLO-03).';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `production_incubation_events`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `production_incubation_events` (
  `id` binary(16) NOT NULL,
  `batch_id` binary(16) NOT NULL,
  `event_type` varchar(25) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `qty_infertile` int DEFAULT NULL,
  `qty_early_dead` int DEFAULT NULL,
  `qty_transferred` int DEFAULT NULL,
  `qty_hatched_viable` int DEFAULT NULL,
  `qty_hatched_nonviable` int DEFAULT NULL,
  `qty_unhatched` int DEFAULT NULL,
  `output_location_id` binary(16) DEFAULT NULL,
  `status` varchar(15) COLLATE utf8mb4_0900_as_cs NOT NULL DEFAULT 'RECORDED',
  `single_step_key` varchar(60) COLLATE utf8mb4_0900_as_cs GENERATED ALWAYS AS ((case when ((`status` = _utf8mb4'RECORDED') and (`event_type` in (_utf8mb4'TRANSFER_TO_HATCHER',_utf8mb4'HATCH'))) then concat(hex(`batch_id`),_utf8mb4':',`event_type`) end)) STORED,
  `cancelled_at` datetime(6) DEFAULT NULL,
  `cancelled_by` binary(16) DEFAULT NULL,
  `cancel_reason_code_id` binary(16) DEFAULT NULL,
  `cancel_comment` text COLLATE utf8mb4_0900_as_cs,
  `cancel_approval_request_id` binary(16) DEFAULT NULL,
  `occurred_at` datetime(6) NOT NULL,
  `client_created_at` datetime(6) DEFAULT NULL,
  `received_at_server` datetime(6) DEFAULT NULL,
  `command_id` binary(16) DEFAULT NULL,
  `created_device_id` binary(16) DEFAULT NULL,
  `captured_offline` tinyint(1) NOT NULL DEFAULT '0',
  `clock_suspect` tinyint(1) NOT NULL DEFAULT '0',
  `backdated_reason` text COLLATE utf8mb4_0900_as_cs,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_production_incubation_events_command` (`command_id`),
  UNIQUE KEY `uq_production_incubation_events_single_step` (`single_step_key`),
  KEY `ix_production_incubation_events_batch` (`batch_id`,`occurred_at`),
  KEY `fk_production_incubation_events_location` (`output_location_id`),
  KEY `fk_production_incubation_events_device` (`created_device_id`),
  KEY `fk_production_incubation_events_created_by` (`created_by`),
  CONSTRAINT `fk_production_incubation_events_batch` FOREIGN KEY (`batch_id`) REFERENCES `production_incubation_batches` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_production_incubation_events_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_production_incubation_events_device` FOREIGN KEY (`created_device_id`) REFERENCES `identity_devices` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_production_incubation_events_location` FOREIGN KEY (`output_location_id`) REFERENCES `organization_locations` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_production_incubation_events_qty` CHECK (((coalesce(`qty_infertile`,0) >= 0) and (coalesce(`qty_early_dead`,0) >= 0) and (coalesce(`qty_transferred`,0) >= 0) and (coalesce(`qty_hatched_viable`,0) >= 0) and (coalesce(`qty_hatched_nonviable`,0) >= 0) and (coalesce(`qty_unhatched`,0) >= 0))),
  CONSTRAINT `ck_production_incubation_events_status` CHECK ((`status` in (_utf8mb4'RECORDED',_utf8mb4'CANCELLED'))),
  CONSTRAINT `ck_production_incubation_events_type` CHECK ((`event_type` in (_utf8mb4'SET',_utf8mb4'CANDLING',_utf8mb4'TRANSFER_TO_HATCHER',_utf8mb4'HATCH',_utf8mb4'CANCEL')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_production_incubation_events_update_guard` BEFORE UPDATE ON `production_incubation_events` FOR EACH ROW BEGIN
  IF NOT (
    NEW.batch_id <=> OLD.batch_id AND NEW.event_type <=> OLD.event_type AND
    NEW.qty_infertile <=> OLD.qty_infertile AND NEW.qty_early_dead <=> OLD.qty_early_dead AND
    NEW.qty_transferred <=> OLD.qty_transferred AND NEW.qty_hatched_viable <=> OLD.qty_hatched_viable AND
    NEW.qty_hatched_nonviable <=> OLD.qty_hatched_nonviable AND NEW.qty_unhatched <=> OLD.qty_unhatched AND
    NEW.occurred_at <=> OLD.occurred_at AND NEW.command_id <=> OLD.command_id
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_incubation_events : étape non modifiable ; annuler.';
  END IF;
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_production_incubation_events_no_delete` BEFORE DELETE ON `production_incubation_events` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_incubation_events : suppression physique interdite (INV-GLO-03).';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `production_lot_entries`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `production_lot_entries` (
  `id` binary(16) NOT NULL,
  `production_lot_id` binary(16) NOT NULL,
  `entry_type` varchar(15) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `product_id` binary(16) NOT NULL,
  `quantity_base` decimal(14,3) NOT NULL,
  `to_location_id` binary(16) NOT NULL,
  `source_kind` varchar(20) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `source_location_id` binary(16) DEFAULT NULL,
  `source_product_id` binary(16) DEFAULT NULL,
  `source_stock_lot_id` binary(16) DEFAULT NULL,
  `source_production_lot_id` binary(16) DEFAULT NULL,
  `goods_receipt_id` binary(16) DEFAULT NULL,
  `stillborn_qty` int NOT NULL DEFAULT '0',
  `avg_weight_g` decimal(10,1) DEFAULT NULL,
  `unit_cost_xaf` bigint DEFAULT NULL,
  `value_xaf` bigint NOT NULL DEFAULT '0',
  `status` varchar(15) COLLATE utf8mb4_0900_as_cs NOT NULL DEFAULT 'RECORDED',
  `cancelled_at` datetime(6) DEFAULT NULL,
  `cancelled_by` binary(16) DEFAULT NULL,
  `cancel_reason_code_id` binary(16) DEFAULT NULL,
  `cancel_comment` text COLLATE utf8mb4_0900_as_cs,
  `cancel_approval_request_id` binary(16) DEFAULT NULL,
  `occurred_at` datetime(6) NOT NULL,
  `client_created_at` datetime(6) DEFAULT NULL,
  `received_at_server` datetime(6) DEFAULT NULL,
  `command_id` binary(16) DEFAULT NULL,
  `created_device_id` binary(16) DEFAULT NULL,
  `captured_offline` tinyint(1) NOT NULL DEFAULT '0',
  `clock_suspect` tinyint(1) NOT NULL DEFAULT '0',
  `backdated_reason` text COLLATE utf8mb4_0900_as_cs,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `updated_by` binary(16) DEFAULT NULL,
  `version` int NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_production_lot_entries_command` (`command_id`),
  KEY `ix_production_lot_entries_lot` (`production_lot_id`,`occurred_at`),
  KEY `ix_production_lot_entries_source_lot` (`source_production_lot_id`),
  KEY `fk_production_lot_entries_product` (`product_id`),
  KEY `fk_production_lot_entries_to_location` (`to_location_id`),
  KEY `fk_production_lot_entries_source_location` (`source_location_id`),
  KEY `fk_production_lot_entries_source_product` (`source_product_id`),
  KEY `fk_production_lot_entries_receipt` (`goods_receipt_id`),
  KEY `fk_production_lot_entries_cancelled_by` (`cancelled_by`),
  KEY `fk_production_lot_entries_device` (`created_device_id`),
  KEY `fk_production_lot_entries_created_by` (`created_by`),
  CONSTRAINT `fk_production_lot_entries_cancelled_by` FOREIGN KEY (`cancelled_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_production_lot_entries_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_production_lot_entries_device` FOREIGN KEY (`created_device_id`) REFERENCES `identity_devices` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_production_lot_entries_lot` FOREIGN KEY (`production_lot_id`) REFERENCES `production_production_lots` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_production_lot_entries_product` FOREIGN KEY (`product_id`) REFERENCES `catalog_products` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_production_lot_entries_receipt` FOREIGN KEY (`goods_receipt_id`) REFERENCES `procurement_goods_receipts` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_production_lot_entries_source_location` FOREIGN KEY (`source_location_id`) REFERENCES `organization_locations` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_production_lot_entries_source_lot` FOREIGN KEY (`source_production_lot_id`) REFERENCES `production_production_lots` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_production_lot_entries_source_product` FOREIGN KEY (`source_product_id`) REFERENCES `catalog_products` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_production_lot_entries_to_location` FOREIGN KEY (`to_location_id`) REFERENCES `organization_locations` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_production_lot_entries_cancel` CHECK ((((`status` = _utf8mb4'CANCELLED') and (`cancelled_at` is not null) and (`cancelled_by` is not null)) or ((`status` <> _utf8mb4'CANCELLED') and (`cancelled_at` is null) and (`cancelled_by` is null) and (`cancel_reason_code_id` is null) and (`cancel_comment` is null)))),
  CONSTRAINT `ck_production_lot_entries_qty` CHECK (((`quantity_base` > 0) and (`stillborn_qty` >= 0) and (`value_xaf` >= 0))),
  CONSTRAINT `ck_production_lot_entries_source` CHECK ((`source_kind` in (_utf8mb4'PURCHASE',_utf8mb4'INTERNAL_STOCK',_utf8mb4'BIRTH',_utf8mb4'TRANSFER',_utf8mb4'WEANING'))),
  CONSTRAINT `ck_production_lot_entries_status` CHECK ((`status` in (_utf8mb4'RECORDED',_utf8mb4'CANCELLED'))),
  CONSTRAINT `ck_production_lot_entries_type` CHECK ((`entry_type` in (_utf8mb4'PLACEMENT',_utf8mb4'BIRTH',_utf8mb4'TRANSFER_IN')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_production_lot_entries_update_guard` BEFORE UPDATE ON `production_lot_entries` FOR EACH ROW BEGIN
  IF NOT (
    NEW.production_lot_id <=> OLD.production_lot_id AND NEW.entry_type <=> OLD.entry_type AND
    NEW.product_id <=> OLD.product_id AND NEW.quantity_base <=> OLD.quantity_base AND
    NEW.to_location_id <=> OLD.to_location_id AND NEW.value_xaf <=> OLD.value_xaf AND
    NEW.occurred_at <=> OLD.occurred_at AND NEW.command_id <=> OLD.command_id AND NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_lot_entries : entrée non modifiable ; annuler puis ressaisir.';
  END IF;
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_production_lot_entries_no_delete` BEFORE DELETE ON `production_lot_entries` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_lot_entries : suppression physique interdite (INV-GLO-03).';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `production_lot_observations`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `production_lot_observations` (
  `id` binary(16) NOT NULL,
  `production_lot_id` binary(16) NOT NULL,
  `observation_type` varchar(15) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `text` text COLLATE utf8mb4_0900_as_cs NOT NULL,
  `severity` varchar(10) COLLATE utf8mb4_0900_as_cs NOT NULL DEFAULT 'INFO',
  `occurred_at` datetime(6) NOT NULL,
  `client_created_at` datetime(6) DEFAULT NULL,
  `received_at_server` datetime(6) DEFAULT NULL,
  `command_id` binary(16) DEFAULT NULL,
  `created_device_id` binary(16) DEFAULT NULL,
  `captured_offline` tinyint(1) NOT NULL DEFAULT '0',
  `clock_suspect` tinyint(1) NOT NULL DEFAULT '0',
  `backdated_reason` text COLLATE utf8mb4_0900_as_cs,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_production_lot_observations_command` (`command_id`),
  KEY `ix_production_lot_observations_lot` (`production_lot_id`,`occurred_at`),
  KEY `fk_production_lot_observations_device` (`created_device_id`),
  KEY `fk_production_lot_observations_created_by` (`created_by`),
  CONSTRAINT `fk_production_lot_observations_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_production_lot_observations_device` FOREIGN KEY (`created_device_id`) REFERENCES `identity_devices` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_production_lot_observations_lot` FOREIGN KEY (`production_lot_id`) REFERENCES `production_production_lots` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_production_lot_observations_severity` CHECK ((`severity` in (_utf8mb4'INFO',_utf8mb4'WARNING',_utf8mb4'CRITICAL'))),
  CONSTRAINT `ck_production_lot_observations_text` CHECK ((char_length(trim(`text`)) > 0)),
  CONSTRAINT `ck_production_lot_observations_type` CHECK ((`observation_type` in (_utf8mb4'SANITAIRE',_utf8mb4'COMPORTEMENT',_utf8mb4'ENVIRONNEMENT',_utf8mb4'INCIDENT',_utf8mb4'AUTRE')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_production_lot_observations_no_update` BEFORE UPDATE ON `production_lot_observations` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_lot_observations : observation immuable ; ajouter une nouvelle observation.';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_production_lot_observations_no_delete` BEFORE DELETE ON `production_lot_observations` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_lot_observations : suppression physique interdite (INV-GLO-03).';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `production_lot_weighings`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `production_lot_weighings` (
  `id` binary(16) NOT NULL,
  `production_lot_id` binary(16) NOT NULL,
  `location_id` binary(16) DEFAULT NULL,
  `sample_size` int NOT NULL,
  `avg_weight_g` decimal(10,1) NOT NULL,
  `total_weight_kg` decimal(12,3) DEFAULT NULL,
  `source` varchar(10) COLLATE utf8mb4_0900_as_cs NOT NULL DEFAULT 'MANUAL',
  `status` varchar(15) COLLATE utf8mb4_0900_as_cs NOT NULL DEFAULT 'RECORDED',
  `cancelled_at` datetime(6) DEFAULT NULL,
  `cancelled_by` binary(16) DEFAULT NULL,
  `cancel_reason_code_id` binary(16) DEFAULT NULL,
  `cancel_comment` text COLLATE utf8mb4_0900_as_cs,
  `cancel_approval_request_id` binary(16) DEFAULT NULL,
  `occurred_at` datetime(6) NOT NULL,
  `client_created_at` datetime(6) DEFAULT NULL,
  `received_at_server` datetime(6) DEFAULT NULL,
  `command_id` binary(16) DEFAULT NULL,
  `created_device_id` binary(16) DEFAULT NULL,
  `captured_offline` tinyint(1) NOT NULL DEFAULT '0',
  `clock_suspect` tinyint(1) NOT NULL DEFAULT '0',
  `backdated_reason` text COLLATE utf8mb4_0900_as_cs,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `updated_by` binary(16) DEFAULT NULL,
  `version` int NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_production_lot_weighings_command` (`command_id`),
  KEY `ix_production_lot_weighings_lot` (`production_lot_id`,`occurred_at`),
  KEY `fk_production_lot_weighings_location` (`location_id`),
  KEY `fk_production_lot_weighings_cancelled_by` (`cancelled_by`),
  KEY `fk_production_lot_weighings_device` (`created_device_id`),
  KEY `fk_production_lot_weighings_created_by` (`created_by`),
  CONSTRAINT `fk_production_lot_weighings_cancelled_by` FOREIGN KEY (`cancelled_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_production_lot_weighings_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_production_lot_weighings_device` FOREIGN KEY (`created_device_id`) REFERENCES `identity_devices` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_production_lot_weighings_location` FOREIGN KEY (`location_id`) REFERENCES `organization_locations` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_production_lot_weighings_lot` FOREIGN KEY (`production_lot_id`) REFERENCES `production_production_lots` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_production_lot_weighings_cancel` CHECK ((((`status` = _utf8mb4'CANCELLED') and (`cancelled_at` is not null) and (`cancelled_by` is not null)) or ((`status` <> _utf8mb4'CANCELLED') and (`cancelled_at` is null) and (`cancelled_by` is null) and (`cancel_reason_code_id` is null) and (`cancel_comment` is null)))),
  CONSTRAINT `ck_production_lot_weighings_source` CHECK ((`source` in (_utf8mb4'MANUAL',_utf8mb4'DEVICE'))),
  CONSTRAINT `ck_production_lot_weighings_status` CHECK ((`status` in (_utf8mb4'RECORDED',_utf8mb4'CANCELLED'))),
  CONSTRAINT `ck_production_lot_weighings_values` CHECK (((`sample_size` > 0) and (`avg_weight_g` > 0) and ((`total_weight_kg` is null) or (`total_weight_kg` > 0))))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_production_lot_weighings_update_guard` BEFORE UPDATE ON `production_lot_weighings` FOR EACH ROW BEGIN
  IF NOT (
    NEW.production_lot_id <=> OLD.production_lot_id AND NEW.sample_size <=> OLD.sample_size AND
    NEW.avg_weight_g <=> OLD.avg_weight_g AND NEW.total_weight_kg <=> OLD.total_weight_kg AND
    NEW.occurred_at <=> OLD.occurred_at AND NEW.command_id <=> OLD.command_id AND NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_lot_weighings : pesée non modifiable ; annuler puis ressaisir.';
  END IF;
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_production_lot_weighings_no_delete` BEFORE DELETE ON `production_lot_weighings` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_lot_weighings : suppression physique interdite (INV-GLO-03).';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `production_overhead_allocation_lines`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `production_overhead_allocation_lines` (
  `id` binary(16) NOT NULL,
  `allocation_id` binary(16) NOT NULL,
  `production_lot_id` binary(16) NOT NULL,
  `head_days` decimal(18,3) NOT NULL,
  `amount_xaf` bigint NOT NULL,
  `cost_entry_id` binary(16) DEFAULT NULL,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_production_overhead_allocation_lines_lot` (`allocation_id`,`production_lot_id`),
  KEY `fk_production_overhead_allocation_lines_lot` (`production_lot_id`),
  CONSTRAINT `fk_production_overhead_allocation_lines_allocation` FOREIGN KEY (`allocation_id`) REFERENCES `production_overhead_allocations` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_production_overhead_allocation_lines_lot` FOREIGN KEY (`production_lot_id`) REFERENCES `production_production_lots` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_production_overhead_allocation_lines_values` CHECK (((`head_days` >= 0) and (`amount_xaf` >= 0)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_production_overhead_allocation_lines_no_update` BEFORE UPDATE ON `production_overhead_allocation_lines` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_overhead_allocation_lines : ligne immuable.';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_production_overhead_allocation_lines_no_delete` BEFORE DELETE ON `production_overhead_allocation_lines` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_overhead_allocation_lines : suppression physique interdite (INV-GLO-03).';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `production_overhead_allocations`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `production_overhead_allocations` (
  `id` binary(16) NOT NULL,
  `site_id` binary(16) NOT NULL,
  `species_group` varchar(10) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `period` char(7) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `run_kind` varchar(20) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `sequence` int NOT NULL,
  `pool_xaf` bigint NOT NULL,
  `allocated_xaf` bigint NOT NULL,
  `head_days_total` decimal(18,3) NOT NULL,
  `production_lot_id` binary(16) DEFAULT NULL,
  `occurred_at` datetime(6) NOT NULL,
  `command_id` binary(16) DEFAULT NULL,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_production_overhead_allocations_run` (`site_id`,`species_group`,`period`,`sequence`),
  UNIQUE KEY `uq_production_overhead_allocations_command` (`command_id`),
  KEY `ix_production_overhead_allocations_lot` (`production_lot_id`),
  KEY `fk_production_overhead_allocations_created_by` (`created_by`),
  CONSTRAINT `fk_production_overhead_allocations_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_production_overhead_allocations_lot` FOREIGN KEY (`production_lot_id`) REFERENCES `production_production_lots` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_production_overhead_allocations_site` FOREIGN KEY (`site_id`) REFERENCES `organization_sites` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_production_overhead_allocations_amounts` CHECK (((`pool_xaf` >= 0) and (`allocated_xaf` >= 0) and (`allocated_xaf` <= `pool_xaf`) and (`head_days_total` >= 0))),
  CONSTRAINT `ck_production_overhead_allocations_estimate` CHECK (((`run_kind` = _utf8mb4'CLOSING_ESTIMATE') = (`production_lot_id` is not null))),
  CONSTRAINT `ck_production_overhead_allocations_kind` CHECK ((`run_kind` in (_utf8mb4'INITIAL',_utf8mb4'REGULARIZATION',_utf8mb4'CLOSING_ESTIMATE'))),
  CONSTRAINT `ck_production_overhead_allocations_period` CHECK (regexp_like(`period`,_utf8mb4'^[0-9]{4}-(0[1-9]|1[0-2])$')),
  CONSTRAINT `ck_production_overhead_allocations_species` CHECK ((`species_group` in (_utf8mb4'VOLAILLE',_utf8mb4'PORC')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_production_overhead_allocations_no_update` BEFORE UPDATE ON `production_overhead_allocations` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_overhead_allocations : répartition jamais réécrite (ADR-026) ; régulariser.';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_production_overhead_allocations_no_delete` BEFORE DELETE ON `production_overhead_allocations` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_overhead_allocations : suppression physique interdite (INV-GLO-03).';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `production_production_lots`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `production_production_lots` (
  `id` binary(16) NOT NULL,
  `lot_code` varchar(40) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `lot_type` varchar(25) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `product_id` binary(16) NOT NULL,
  `stock_lot_id` binary(16) NOT NULL,
  `site_id` binary(16) NOT NULL,
  `main_location_id` binary(16) NOT NULL,
  `parent_lot_id` binary(16) DEFAULT NULL,
  `supplier_id` binary(16) DEFAULT NULL,
  `strain` varchar(100) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `planned_start_date` date DEFAULT NULL,
  `start_date` date DEFAULT NULL,
  `initial_quantity` decimal(14,3) DEFAULT NULL,
  `planned_end_date` date DEFAULT NULL,
  `status` varchar(15) COLLATE utf8mb4_0900_as_cs NOT NULL DEFAULT 'PLANNED',
  `closed_at` datetime(6) DEFAULT NULL,
  `closing_summary` json DEFAULT NULL,
  `notes` text COLLATE utf8mb4_0900_as_cs,
  `cancelled_at` datetime(6) DEFAULT NULL,
  `cancelled_by` binary(16) DEFAULT NULL,
  `cancel_reason_code_id` binary(16) DEFAULT NULL,
  `cancel_comment` text COLLATE utf8mb4_0900_as_cs,
  `cancel_approval_request_id` binary(16) DEFAULT NULL,
  `occurred_at` datetime(6) NOT NULL,
  `client_created_at` datetime(6) DEFAULT NULL,
  `received_at_server` datetime(6) DEFAULT NULL,
  `command_id` binary(16) DEFAULT NULL,
  `created_device_id` binary(16) DEFAULT NULL,
  `captured_offline` tinyint(1) NOT NULL DEFAULT '0',
  `clock_suspect` tinyint(1) NOT NULL DEFAULT '0',
  `backdated_reason` text COLLATE utf8mb4_0900_as_cs,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `updated_by` binary(16) DEFAULT NULL,
  `version` int NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_production_production_lots_code` (`lot_code`),
  UNIQUE KEY `uq_production_production_lots_stock_lot` (`stock_lot_id`),
  UNIQUE KEY `uq_production_production_lots_command` (`command_id`),
  KEY `ix_production_production_lots_site_status` (`site_id`,`status`),
  KEY `ix_production_production_lots_parent` (`parent_lot_id`),
  KEY `fk_production_production_lots_product` (`product_id`),
  KEY `fk_production_production_lots_location` (`main_location_id`),
  KEY `fk_production_production_lots_supplier` (`supplier_id`),
  KEY `fk_production_production_lots_cancelled_by` (`cancelled_by`),
  KEY `fk_production_production_lots_cancel_reason` (`cancel_reason_code_id`),
  KEY `fk_production_production_lots_device` (`created_device_id`),
  KEY `fk_production_production_lots_created_by` (`created_by`),
  KEY `fk_production_production_lots_updated_by` (`updated_by`),
  CONSTRAINT `fk_production_production_lots_cancel_reason` FOREIGN KEY (`cancel_reason_code_id`) REFERENCES `catalog_reason_codes` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_production_production_lots_cancelled_by` FOREIGN KEY (`cancelled_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_production_production_lots_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_production_production_lots_device` FOREIGN KEY (`created_device_id`) REFERENCES `identity_devices` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_production_production_lots_location` FOREIGN KEY (`main_location_id`) REFERENCES `organization_locations` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_production_production_lots_parent` FOREIGN KEY (`parent_lot_id`) REFERENCES `production_production_lots` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_production_production_lots_product` FOREIGN KEY (`product_id`) REFERENCES `catalog_products` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_production_production_lots_site` FOREIGN KEY (`site_id`) REFERENCES `organization_sites` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_production_production_lots_stock_lot` FOREIGN KEY (`stock_lot_id`) REFERENCES `inventory_stock_lots` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_production_production_lots_supplier` FOREIGN KEY (`supplier_id`) REFERENCES `procurement_suppliers` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_production_production_lots_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_production_production_lots_cancel` CHECK ((((`status` = _utf8mb4'CANCELLED') and (`cancelled_at` is not null) and (`cancelled_by` is not null)) or ((`status` <> _utf8mb4'CANCELLED') and (`cancelled_at` is null) and (`cancelled_by` is null) and (`cancel_reason_code_id` is null) and (`cancel_comment` is null)))),
  CONSTRAINT `ck_production_production_lots_closed` CHECK (((`status` <> _utf8mb4'CLOSED') or (`closed_at` is not null))),
  CONSTRAINT `ck_production_production_lots_initial` CHECK (((`initial_quantity` is null) or (`initial_quantity` >= 0))),
  CONSTRAINT `ck_production_production_lots_parent` CHECK (((`parent_lot_id` is null) or (`parent_lot_id` <> `id`))),
  CONSTRAINT `ck_production_production_lots_status` CHECK ((`status` in (_utf8mb4'PLANNED',_utf8mb4'ACTIVE',_utf8mb4'SELLING',_utf8mb4'CLOSED',_utf8mb4'CANCELLED'))),
  CONSTRAINT `ck_production_production_lots_type` CHECK ((`lot_type` in (_utf8mb4'POULET_CHAIR',_utf8mb4'PONDEUSE',_utf8mb4'PORC_ENGRAISSEMENT',_utf8mb4'REPRODUCTEUR_VOLAILLE',_utf8mb4'PORC_NAISSAGE')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_production_production_lots_update_guard` BEFORE UPDATE ON `production_production_lots` FOR EACH ROW BEGIN
  IF NOT (
    NEW.lot_code <=> OLD.lot_code AND NEW.lot_type <=> OLD.lot_type AND NEW.product_id <=> OLD.product_id AND
    NEW.stock_lot_id <=> OLD.stock_lot_id AND NEW.site_id <=> OLD.site_id AND
    NEW.occurred_at <=> OLD.occurred_at AND NEW.command_id <=> OLD.command_id AND
    NEW.created_at <=> OLD.created_at AND NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_production_lots : code, type, produit, lot de stock et ferme immuables.';
  END IF;
  IF OLD.status IN ('CLOSED', 'CANCELLED') AND NOT (NEW.status <=> OLD.status) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_production_lots : un lot clôturé ou annulé ne change plus de statut.';
  END IF;
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_production_production_lots_no_delete` BEFORE DELETE ON `production_production_lots` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_production_lots : suppression physique interdite (INV-GLO-03).';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `production_slaughter_batches`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `production_slaughter_batches` (
  `id` binary(16) NOT NULL,
  `doc_number` varchar(40) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `production_lot_id` binary(16) NOT NULL,
  `site_id` binary(16) NOT NULL,
  `source_location_id` binary(16) NOT NULL,
  `location_id` binary(16) NOT NULL,
  `input_product_id` binary(16) NOT NULL,
  `heads_qty` int NOT NULL,
  `condemned_heads` int NOT NULL DEFAULT '0',
  `live_weight_g` bigint NOT NULL,
  `output_weight_g` bigint NOT NULL,
  `total_input_value_xaf` bigint NOT NULL DEFAULT '0',
  `yield_rate` decimal(5,4) DEFAULT NULL,
  `stock_lot_id` binary(16) NOT NULL,
  `status` varchar(15) COLLATE utf8mb4_0900_as_cs NOT NULL DEFAULT 'RECORDED',
  `cancelled_at` datetime(6) DEFAULT NULL,
  `cancelled_by` binary(16) DEFAULT NULL,
  `cancel_reason_code_id` binary(16) DEFAULT NULL,
  `cancel_comment` text COLLATE utf8mb4_0900_as_cs,
  `cancel_approval_request_id` binary(16) DEFAULT NULL,
  `occurred_at` datetime(6) NOT NULL,
  `client_created_at` datetime(6) DEFAULT NULL,
  `received_at_server` datetime(6) DEFAULT NULL,
  `command_id` binary(16) DEFAULT NULL,
  `created_device_id` binary(16) DEFAULT NULL,
  `captured_offline` tinyint(1) NOT NULL DEFAULT '0',
  `clock_suspect` tinyint(1) NOT NULL DEFAULT '0',
  `backdated_reason` text COLLATE utf8mb4_0900_as_cs,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `updated_by` binary(16) DEFAULT NULL,
  `version` int NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_production_slaughter_batches_doc_number` (`doc_number`),
  UNIQUE KEY `uq_production_slaughter_batches_stock_lot` (`stock_lot_id`),
  UNIQUE KEY `uq_production_slaughter_batches_command` (`command_id`),
  KEY `ix_production_slaughter_batches_lot` (`production_lot_id`,`occurred_at`),
  KEY `fk_production_slaughter_batches_site` (`site_id`),
  KEY `fk_production_slaughter_batches_source` (`source_location_id`),
  KEY `fk_production_slaughter_batches_location` (`location_id`),
  KEY `fk_production_slaughter_batches_product` (`input_product_id`),
  KEY `fk_production_slaughter_batches_cancelled_by` (`cancelled_by`),
  KEY `fk_production_slaughter_batches_device` (`created_device_id`),
  KEY `fk_production_slaughter_batches_created_by` (`created_by`),
  CONSTRAINT `fk_production_slaughter_batches_cancelled_by` FOREIGN KEY (`cancelled_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_production_slaughter_batches_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_production_slaughter_batches_device` FOREIGN KEY (`created_device_id`) REFERENCES `identity_devices` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_production_slaughter_batches_location` FOREIGN KEY (`location_id`) REFERENCES `organization_locations` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_production_slaughter_batches_lot` FOREIGN KEY (`production_lot_id`) REFERENCES `production_production_lots` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_production_slaughter_batches_product` FOREIGN KEY (`input_product_id`) REFERENCES `catalog_products` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_production_slaughter_batches_site` FOREIGN KEY (`site_id`) REFERENCES `organization_sites` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_production_slaughter_batches_source` FOREIGN KEY (`source_location_id`) REFERENCES `organization_locations` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_production_slaughter_batches_stock_lot` FOREIGN KEY (`stock_lot_id`) REFERENCES `inventory_stock_lots` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_production_slaughter_batches_cancel` CHECK ((((`status` = _utf8mb4'CANCELLED') and (`cancelled_at` is not null) and (`cancelled_by` is not null)) or ((`status` <> _utf8mb4'CANCELLED') and (`cancelled_at` is null) and (`cancelled_by` is null) and (`cancel_reason_code_id` is null) and (`cancel_comment` is null)))),
  CONSTRAINT `ck_production_slaughter_batches_status` CHECK ((`status` in (_utf8mb4'RECORDED',_utf8mb4'CANCELLED'))),
  CONSTRAINT `ck_production_slaughter_batches_values` CHECK (((`heads_qty` > 0) and (`condemned_heads` >= 0) and (`condemned_heads` <= `heads_qty`) and (`live_weight_g` > 0) and (`output_weight_g` > 0) and (`output_weight_g` <= `live_weight_g`) and (`total_input_value_xaf` >= 0)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_production_slaughter_batches_update_guard` BEFORE UPDATE ON `production_slaughter_batches` FOR EACH ROW BEGIN
  IF NOT (
    NEW.doc_number <=> OLD.doc_number AND NEW.production_lot_id <=> OLD.production_lot_id AND
    NEW.heads_qty <=> OLD.heads_qty AND NEW.condemned_heads <=> OLD.condemned_heads AND
    NEW.live_weight_g <=> OLD.live_weight_g AND NEW.output_weight_g <=> OLD.output_weight_g AND
    NEW.total_input_value_xaf <=> OLD.total_input_value_xaf AND NEW.stock_lot_id <=> OLD.stock_lot_id AND
    NEW.occurred_at <=> OLD.occurred_at AND NEW.command_id <=> OLD.command_id AND NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_slaughter_batches : abattage non modifiable ; annuler.';
  END IF;
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_production_slaughter_batches_no_delete` BEFORE DELETE ON `production_slaughter_batches` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_slaughter_batches : suppression physique interdite (INV-GLO-03).';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `production_slaughter_outputs`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `production_slaughter_outputs` (
  `id` binary(16) NOT NULL,
  `slaughter_id` binary(16) NOT NULL,
  `product_id` binary(16) NOT NULL,
  `to_location_id` binary(16) NOT NULL,
  `quantity_base` decimal(14,3) NOT NULL,
  `weight_g` bigint NOT NULL,
  `allocated_value_xaf` bigint NOT NULL,
  `unit_cost_xaf` bigint NOT NULL,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_production_slaughter_outputs_product` (`slaughter_id`,`product_id`),
  KEY `fk_production_slaughter_outputs_product` (`product_id`),
  KEY `fk_production_slaughter_outputs_location` (`to_location_id`),
  CONSTRAINT `fk_production_slaughter_outputs_location` FOREIGN KEY (`to_location_id`) REFERENCES `organization_locations` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_production_slaughter_outputs_product` FOREIGN KEY (`product_id`) REFERENCES `catalog_products` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_production_slaughter_outputs_slaughter` FOREIGN KEY (`slaughter_id`) REFERENCES `production_slaughter_batches` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_production_slaughter_outputs_values` CHECK (((`quantity_base` > 0) and (`weight_g` > 0) and (`allocated_value_xaf` >= 0) and (`unit_cost_xaf` >= 0)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_production_slaughter_outputs_no_update` BEFORE UPDATE ON `production_slaughter_outputs` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_slaughter_outputs : ligne immuable.';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_production_slaughter_outputs_no_delete` BEFORE DELETE ON `production_slaughter_outputs` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_slaughter_outputs : suppression physique interdite (INV-GLO-03).';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `sales_customer_payments`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `sales_customer_payments` (
  `id` binary(16) NOT NULL,
  `doc_number` varchar(40) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `local_ref` varchar(20) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `site_id` binary(16) NOT NULL,
  `customer_id` binary(16) DEFAULT NULL,
  `payment_method_code` varchar(40) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `amount_xaf` bigint NOT NULL,
  `external_reference` varchar(80) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `reference_normalized` varchar(80) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `reference_key` varchar(121) COLLATE utf8mb4_0900_as_cs GENERATED ALWAYS AS ((case when ((`reference_normalized` is not null) and (`status` in (_utf8mb4'RECORDED',_utf8mb4'CANCELLATION_REQUESTED'))) then concat(`payment_method_code`,_utf8mb4':',`reference_normalized`) end)) STORED,
  `received_by_user_id` binary(16) NOT NULL,
  `cash_account_id` binary(16) NOT NULL,
  `cash_session_id` binary(16) DEFAULT NULL,
  `cash_movement_id` binary(16) DEFAULT NULL,
  `status` varchar(25) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `duplicate_of_payment_id` binary(16) DEFAULT NULL,
  `intended_sale_id` binary(16) DEFAULT NULL,
  `intended_order_id` binary(16) DEFAULT NULL,
  `unallocated_xaf` bigint NOT NULL,
  `refunded_xaf` bigint NOT NULL DEFAULT '0',
  `cancelled_at` datetime(6) DEFAULT NULL,
  `cancelled_by` binary(16) DEFAULT NULL,
  `cancel_reason_code_id` binary(16) DEFAULT NULL,
  `cancel_comment` text COLLATE utf8mb4_0900_as_cs,
  `cancel_approval_request_id` binary(16) DEFAULT NULL,
  `occurred_at` datetime(6) NOT NULL,
  `business_date` date GENERATED ALWAYS AS (cast(convert_tz(`occurred_at`,_utf8mb4'+00:00',_utf8mb4'+01:00') as date)) STORED,
  `client_created_at` datetime(6) DEFAULT NULL,
  `received_at_server` datetime(6) DEFAULT NULL,
  `command_id` binary(16) DEFAULT NULL,
  `created_device_id` binary(16) DEFAULT NULL,
  `captured_offline` tinyint(1) NOT NULL DEFAULT '0',
  `clock_suspect` tinyint(1) NOT NULL DEFAULT '0',
  `backdated_reason` text COLLATE utf8mb4_0900_as_cs,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `updated_by` binary(16) DEFAULT NULL,
  `version` int NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_sales_customer_payments_doc_number` (`doc_number`),
  UNIQUE KEY `uq_sales_customer_payments_device_ref` (`created_device_id`,`local_ref`),
  UNIQUE KEY `uq_sales_customer_payments_reference` (`reference_key`),
  UNIQUE KEY `uq_sales_customer_payments_movement` (`cash_movement_id`),
  KEY `ix_sales_customer_payments_customer` (`customer_id`,`occurred_at`),
  KEY `ix_sales_customer_payments_session` (`cash_session_id`),
  KEY `ix_sales_customer_payments_business_date` (`site_id`,`business_date`),
  KEY `ix_sales_customer_payments_status` (`status`,`occurred_at`),
  KEY `ix_sales_customer_payments_command` (`command_id`),
  KEY `fk_sales_customer_payments_method` (`payment_method_code`),
  KEY `fk_sales_customer_payments_received_by` (`received_by_user_id`),
  KEY `fk_sales_customer_payments_cash_account` (`cash_account_id`),
  KEY `fk_sales_customer_payments_duplicate_of` (`duplicate_of_payment_id`),
  KEY `fk_sales_customer_payments_cancelled_by` (`cancelled_by`),
  KEY `fk_sales_customer_payments_cancel_reason` (`cancel_reason_code_id`),
  KEY `fk_sales_customer_payments_cancel_approval` (`cancel_approval_request_id`),
  KEY `fk_sales_customer_payments_created_by` (`created_by`),
  KEY `fk_sales_customer_payments_updated_by` (`updated_by`),
  KEY `fk_sales_customer_payments_intended_sale` (`intended_sale_id`),
  KEY `fk_sales_customer_payments_intended_order` (`intended_order_id`),
  CONSTRAINT `fk_sales_customer_payments_cancel_approval` FOREIGN KEY (`cancel_approval_request_id`) REFERENCES `approvals_approval_requests` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_customer_payments_cancel_reason` FOREIGN KEY (`cancel_reason_code_id`) REFERENCES `catalog_reason_codes` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_customer_payments_cancelled_by` FOREIGN KEY (`cancelled_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_customer_payments_cash_account` FOREIGN KEY (`cash_account_id`) REFERENCES `finance_cash_accounts` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_customer_payments_cash_movement` FOREIGN KEY (`cash_movement_id`) REFERENCES `finance_cash_movements` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_customer_payments_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_customer_payments_created_device` FOREIGN KEY (`created_device_id`) REFERENCES `identity_devices` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_customer_payments_customer` FOREIGN KEY (`customer_id`) REFERENCES `crm_customers` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_customer_payments_duplicate_of` FOREIGN KEY (`duplicate_of_payment_id`) REFERENCES `sales_customer_payments` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_customer_payments_intended_order` FOREIGN KEY (`intended_order_id`) REFERENCES `sales_sales_orders` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_customer_payments_intended_sale` FOREIGN KEY (`intended_sale_id`) REFERENCES `sales_sales` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_customer_payments_method` FOREIGN KEY (`payment_method_code`) REFERENCES `finance_payment_methods` (`code`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_customer_payments_received_by` FOREIGN KEY (`received_by_user_id`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_customer_payments_site` FOREIGN KEY (`site_id`) REFERENCES `organization_sites` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_customer_payments_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_sales_customer_payments_amount` CHECK ((`amount_xaf` > 0)),
  CONSTRAINT `ck_sales_customer_payments_cancel` CHECK ((((`status` = _utf8mb4'CANCELLED') and (`cancelled_at` is not null) and (`cancelled_by` is not null)) or ((`status` <> _utf8mb4'CANCELLED') and (`cancelled_at` is null) and (`cancelled_by` is null)))),
  CONSTRAINT `ck_sales_customer_payments_cancel_request` CHECK (((`status` in (_utf8mb4'CANCELLATION_REQUESTED',_utf8mb4'CANCELLED')) or ((`cancel_reason_code_id` is null) and (`cancel_comment` is null) and (`cancel_approval_request_id` is null)))),
  CONSTRAINT `ck_sales_customer_payments_credit` CHECK (((`unallocated_xaf` = 0) or ((`status` in (_utf8mb4'RECORDED',_utf8mb4'CANCELLATION_REQUESTED')) and (`customer_id` is not null)))),
  CONSTRAINT `ck_sales_customer_payments_intended` CHECK (((`intended_sale_id` is null) or (`intended_order_id` is null))),
  CONSTRAINT `ck_sales_customer_payments_movement` CHECK ((((`status` in (_utf8mb4'RECORDED',_utf8mb4'CANCELLATION_REQUESTED',_utf8mb4'CANCELLED')) and (`cash_movement_id` is not null)) or ((`status` in (_utf8mb4'SUSPECT_DUPLICATE',_utf8mb4'REJECTED')) and (`cash_movement_id` is null)))),
  CONSTRAINT `ck_sales_customer_payments_reference` CHECK (((`reference_normalized` is null) or ((`reference_normalized` = upper(`reference_normalized`)) and (not(regexp_like(`reference_normalized`,_utf8mb4'[[:space:]]')))))),
  CONSTRAINT `ck_sales_customer_payments_reference_pair` CHECK (((`external_reference` is null) or (`reference_normalized` is not null))),
  CONSTRAINT `ck_sales_customer_payments_status` CHECK ((`status` in (_utf8mb4'RECORDED',_utf8mb4'SUSPECT_DUPLICATE',_utf8mb4'REJECTED',_utf8mb4'CANCELLATION_REQUESTED',_utf8mb4'CANCELLED'))),
  CONSTRAINT `ck_sales_customer_payments_unallocated` CHECK (((`unallocated_xaf` >= 0) and (`refunded_xaf` >= 0) and ((`unallocated_xaf` + `refunded_xaf`) <= `amount_xaf`)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_sales_customer_payments_update_guard` BEFORE UPDATE ON `sales_customer_payments` FOR EACH ROW BEGIN
  IF NOT (
    NEW.doc_number <=> OLD.doc_number AND
    NEW.local_ref <=> OLD.local_ref AND
    NEW.site_id <=> OLD.site_id AND
    NEW.customer_id <=> OLD.customer_id AND
    NEW.payment_method_code <=> OLD.payment_method_code AND
    NEW.amount_xaf <=> OLD.amount_xaf AND
    NEW.received_by_user_id <=> OLD.received_by_user_id AND
    NEW.cash_account_id <=> OLD.cash_account_id AND
    NEW.duplicate_of_payment_id <=> OLD.duplicate_of_payment_id AND
    NEW.intended_sale_id <=> OLD.intended_sale_id AND
    NEW.intended_order_id <=> OLD.intended_order_id AND
    NEW.occurred_at <=> OLD.occurred_at AND
    NEW.client_created_at <=> OLD.client_created_at AND
    NEW.received_at_server <=> OLD.received_at_server AND
    NEW.command_id <=> OLD.command_id AND
    NEW.created_device_id <=> OLD.created_device_id AND
    NEW.captured_offline <=> OLD.captured_offline AND
    NEW.clock_suspect <=> OLD.clock_suspect AND
    NEW.backdated_reason <=> OLD.backdated_reason AND
    NEW.created_at <=> OLD.created_at AND
    NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_customer_payments : encaissement immuable ; seuls statut, part non affectée et annulation évoluent.';
  END IF;
  -- La référence ne se corrige qu'à la décision de la Finance sur un doublon suspect (AV-135).
  IF NOT (NEW.external_reference <=> OLD.external_reference AND NEW.reference_normalized <=> OLD.reference_normalized)
     AND NOT (OLD.status = 'SUSPECT_DUPLICATE' AND NEW.status = 'RECORDED') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_customer_payments : référence figée, corrigeable seulement à la décision sur un doublon suspect.';
  END IF;
  IF OLD.status IN ('REJECTED', 'CANCELLED') AND NEW.status <> OLD.status THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_customer_payments : encaissement rejeté ou annulé, son statut ne change plus.';
  END IF;
  IF OLD.status IN ('REJECTED', 'CANCELLED') AND NOT (
    NEW.unallocated_xaf <=> OLD.unallocated_xaf AND
    NEW.refunded_xaf <=> OLD.refunded_xaf AND
    NEW.cancelled_at <=> OLD.cancelled_at AND
    NEW.cancelled_by <=> OLD.cancelled_by AND
    NEW.cancel_reason_code_id <=> OLD.cancel_reason_code_id AND
    NEW.cancel_comment <=> OLD.cancel_comment AND
    NEW.cancel_approval_request_id <=> OLD.cancel_approval_request_id
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_customer_payments : encaissement terminé, ses montants et son annulation sont figés.';
  END IF;
  IF NEW.refunded_xaf < OLD.refunded_xaf THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_customer_payments : la part remboursée ne diminue jamais.';
  END IF;
  IF OLD.cash_movement_id IS NOT NULL AND NOT (NEW.cash_movement_id <=> OLD.cash_movement_id) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_customer_payments : le mouvement de trésorerie ne change plus (INV-FIN-01).';
  END IF;
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_sales_customer_payments_no_delete` BEFORE DELETE ON `sales_customer_payments` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_customer_payments : suppression physique interdite (INV-GLO-03) ; annuler par contre-écriture.';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `sales_delivery_note_lines`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `sales_delivery_note_lines` (
  `id` binary(16) NOT NULL,
  `delivery_note_id` binary(16) NOT NULL,
  `order_line_id` binary(16) NOT NULL,
  `sale_line_id` binary(16) NOT NULL,
  `quantity_base` decimal(14,3) NOT NULL,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_sales_delivery_note_lines_sale_line` (`delivery_note_id`,`sale_line_id`),
  KEY `ix_sales_delivery_note_lines_order_line` (`order_line_id`),
  KEY `ix_sales_delivery_note_lines_sale_line` (`sale_line_id`),
  CONSTRAINT `fk_sales_delivery_note_lines_note` FOREIGN KEY (`delivery_note_id`) REFERENCES `sales_delivery_notes` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_delivery_note_lines_order_line` FOREIGN KEY (`order_line_id`) REFERENCES `sales_sales_order_lines` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_delivery_note_lines_sale_line` FOREIGN KEY (`sale_line_id`) REFERENCES `sales_sale_lines` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_sales_delivery_note_lines_quantity` CHECK ((`quantity_base` > 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_sales_delivery_note_lines_insert_guard` BEFORE INSERT ON `sales_delivery_note_lines` FOR EACH ROW BEGIN
  DECLARE sl_order_line BINARY(16);
  DECLARE ol_order BINARY(16);
  DECLARE note_order BINARY(16);
  SELECT order_line_id INTO sl_order_line FROM sales_sale_lines WHERE id = NEW.sale_line_id;
  SELECT order_id INTO ol_order FROM sales_sales_order_lines WHERE id = NEW.order_line_id;
  SELECT order_id INTO note_order FROM sales_delivery_notes WHERE id = NEW.delivery_note_id;
  IF sl_order_line IS NULL OR sl_order_line <> NEW.order_line_id OR ol_order IS NULL OR note_order IS NULL
     OR ol_order <> note_order THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_delivery_note_lines : ligne de vente, ligne de commande et commande du bon doivent concorder.';
  END IF;
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_sales_delivery_note_lines_no_update` BEFORE UPDATE ON `sales_delivery_note_lines` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_delivery_note_lines : ligne de livraison immuable (ADR-028 §7).';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_sales_delivery_note_lines_no_delete` BEFORE DELETE ON `sales_delivery_note_lines` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_delivery_note_lines : suppression physique interdite (INV-GLO-03).';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `sales_delivery_notes`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `sales_delivery_notes` (
  `id` binary(16) NOT NULL,
  `doc_number` varchar(40) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `local_ref` varchar(20) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `site_id` binary(16) NOT NULL,
  `order_id` binary(16) NOT NULL,
  `delivered_by_user_id` binary(16) NOT NULL,
  `recipient_name` varchar(200) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `proof_attachment_id` binary(16) DEFAULT NULL,
  `notes` text COLLATE utf8mb4_0900_as_cs,
  `occurred_at` datetime(6) NOT NULL,
  `business_date` date GENERATED ALWAYS AS (cast(convert_tz(`occurred_at`,_utf8mb4'+00:00',_utf8mb4'+01:00') as date)) STORED,
  `client_created_at` datetime(6) DEFAULT NULL,
  `received_at_server` datetime(6) DEFAULT NULL,
  `command_id` binary(16) DEFAULT NULL,
  `created_device_id` binary(16) DEFAULT NULL,
  `captured_offline` tinyint(1) NOT NULL DEFAULT '0',
  `clock_suspect` tinyint(1) NOT NULL DEFAULT '0',
  `backdated_reason` text COLLATE utf8mb4_0900_as_cs,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_sales_delivery_notes_doc_number` (`doc_number`),
  UNIQUE KEY `uq_sales_delivery_notes_command` (`command_id`),
  UNIQUE KEY `uq_sales_delivery_notes_device_ref` (`created_device_id`,`local_ref`),
  KEY `ix_sales_delivery_notes_order` (`order_id`,`occurred_at`),
  KEY `ix_sales_delivery_notes_business_date` (`site_id`,`business_date`),
  KEY `ix_sales_delivery_notes_deliverer` (`delivered_by_user_id`,`business_date`),
  KEY `fk_sales_delivery_notes_proof` (`proof_attachment_id`),
  KEY `fk_sales_delivery_notes_created_by` (`created_by`),
  CONSTRAINT `fk_sales_delivery_notes_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_delivery_notes_created_device` FOREIGN KEY (`created_device_id`) REFERENCES `identity_devices` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_delivery_notes_deliverer` FOREIGN KEY (`delivered_by_user_id`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_delivery_notes_order` FOREIGN KEY (`order_id`) REFERENCES `sales_sales_orders` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_delivery_notes_proof` FOREIGN KEY (`proof_attachment_id`) REFERENCES `attachments_attachments` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_delivery_notes_site` FOREIGN KEY (`site_id`) REFERENCES `organization_sites` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_sales_delivery_notes_no_update` BEFORE UPDATE ON `sales_delivery_notes` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_delivery_notes : bon de livraison immuable (ADR-028 §7).';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_sales_delivery_notes_no_delete` BEFORE DELETE ON `sales_delivery_notes` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_delivery_notes : suppression physique interdite (INV-GLO-03).';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `sales_payment_allocations`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `sales_payment_allocations` (
  `id` binary(16) NOT NULL,
  `payment_id` binary(16) NOT NULL,
  `sale_id` binary(16) DEFAULT NULL,
  `order_id` binary(16) DEFAULT NULL,
  `amount_xaf` bigint NOT NULL,
  `allocated_at` datetime(6) NOT NULL,
  `status` varchar(10) COLLATE utf8mb4_0900_as_cs NOT NULL DEFAULT 'ACTIVE',
  `reversed_at` datetime(6) DEFAULT NULL,
  `reversal_cause` varchar(20) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `command_id` binary(16) DEFAULT NULL,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_sales_payment_allocations_payment` (`payment_id`),
  KEY `ix_sales_payment_allocations_sale` (`sale_id`,`status`),
  KEY `ix_sales_payment_allocations_order` (`order_id`,`status`),
  KEY `ix_sales_payment_allocations_command` (`command_id`),
  KEY `fk_sales_payment_allocations_created_by` (`created_by`),
  CONSTRAINT `fk_sales_payment_allocations_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_payment_allocations_order` FOREIGN KEY (`order_id`) REFERENCES `sales_sales_orders` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_payment_allocations_payment` FOREIGN KEY (`payment_id`) REFERENCES `sales_customer_payments` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_payment_allocations_sale` FOREIGN KEY (`sale_id`) REFERENCES `sales_sales` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_sales_payment_allocations_amount` CHECK ((`amount_xaf` > 0)),
  CONSTRAINT `ck_sales_payment_allocations_cause` CHECK (((`reversal_cause` is null) or (`reversal_cause` in (_utf8mb4'PAYMENT_CANCELLED',_utf8mb4'SALE_CANCELLED',_utf8mb4'REALLOCATED',_utf8mb4'ORDER_CONFIRMED')))),
  CONSTRAINT `ck_sales_payment_allocations_reversal` CHECK ((((`status` = _utf8mb4'ACTIVE') and (`reversed_at` is null) and (`reversal_cause` is null)) or ((`status` = _utf8mb4'REVERSED') and (`reversed_at` is not null) and (`reversal_cause` is not null)))),
  CONSTRAINT `ck_sales_payment_allocations_status` CHECK ((`status` in (_utf8mb4'ACTIVE',_utf8mb4'REVERSED'))),
  CONSTRAINT `ck_sales_payment_allocations_target` CHECK (((`sale_id` is null) <> (`order_id` is null)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_sales_payment_allocations_insert_guard` BEFORE INSERT ON `sales_payment_allocations` FOR EACH ROW BEGIN
  DECLARE p_status VARCHAR(25);
  DECLARE t_status VARCHAR(25);
  -- INV-FIN-09, INV-FIN-10 : on n'affecte qu'un encaissement enregistré, à une cible non annulée.
  IF NEW.status = 'ACTIVE' THEN
    SELECT status INTO p_status FROM sales_customer_payments WHERE id = NEW.payment_id;
    IF p_status IS NULL OR p_status <> 'RECORDED' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_payment_allocations : seul un encaissement enregistré (RECORDED) s''affecte (INV-FIN-09).';
    END IF;
    IF NEW.sale_id IS NOT NULL THEN
      SELECT status INTO t_status FROM sales_sales WHERE id = NEW.sale_id;
    ELSEIF NEW.order_id IS NOT NULL THEN
      SELECT status INTO t_status FROM sales_sales_orders WHERE id = NEW.order_id;
    END IF;
    -- Sans cible (ou avec deux), le CHECK ck_sales_payment_allocations_target tranche.
    IF (NEW.sale_id IS NOT NULL OR NEW.order_id IS NOT NULL) AND (t_status IS NULL OR t_status = 'CANCELLED') THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_payment_allocations : pas d''affectation à une vente ou une commande annulée (INV-FIN-10).';
    END IF;
  END IF;
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_sales_payment_allocations_update_guard` BEFORE UPDATE ON `sales_payment_allocations` FOR EACH ROW BEGIN
  IF NOT (
    NEW.payment_id <=> OLD.payment_id AND
    NEW.sale_id <=> OLD.sale_id AND
    NEW.order_id <=> OLD.order_id AND
    NEW.amount_xaf <=> OLD.amount_xaf AND
    NEW.allocated_at <=> OLD.allocated_at AND
    NEW.command_id <=> OLD.command_id AND
    NEW.created_at <=> OLD.created_at AND
    NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_payment_allocations : affectation immuable ; seul le renversement (REVERSED) est permis.';
  END IF;
  IF OLD.status = 'REVERSED' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_payment_allocations : affectation déjà renversée.';
  END IF;
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_sales_payment_allocations_no_delete` BEFORE DELETE ON `sales_payment_allocations` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_payment_allocations : suppression physique interdite (INV-GLO-03).';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `sales_sale_cancellation_lines`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `sales_sale_cancellation_lines` (
  `id` binary(16) NOT NULL,
  `cancellation_id` binary(16) NOT NULL,
  `sale_line_id` binary(16) NOT NULL,
  `quantity_base` decimal(14,3) NOT NULL,
  `amount_xaf` bigint NOT NULL,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_sales_sale_cancellation_lines_line` (`cancellation_id`,`sale_line_id`),
  KEY `ix_sales_sale_cancellation_lines_sale_line` (`sale_line_id`),
  CONSTRAINT `fk_sales_sale_cancellation_lines_cancellation` FOREIGN KEY (`cancellation_id`) REFERENCES `sales_sale_cancellations` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_sale_cancellation_lines_sale_line` FOREIGN KEY (`sale_line_id`) REFERENCES `sales_sale_lines` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_sales_sale_cancellation_lines_amounts` CHECK (((`quantity_base` > 0) and (`amount_xaf` >= 0)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_sales_sale_cancellation_lines_insert_guard` BEFORE INSERT ON `sales_sale_cancellation_lines` FOR EACH ROW BEGIN
  DECLARE line_sale BINARY(16);
  DECLARE doc_sale BINARY(16);
  SELECT sale_id INTO line_sale FROM sales_sale_lines WHERE id = NEW.sale_line_id;
  SELECT sale_id INTO doc_sale FROM sales_sale_cancellations WHERE id = NEW.cancellation_id;
  IF line_sale IS NULL OR doc_sale IS NULL OR line_sale <> doc_sale THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_sale_cancellation_lines : la ligne annulée doit appartenir à la vente du document.';
  END IF;
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_sales_sale_cancellation_lines_no_update` BEFORE UPDATE ON `sales_sale_cancellation_lines` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_sale_cancellation_lines : ligne d''annulation immuable (contre-écriture).';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_sales_sale_cancellation_lines_no_delete` BEFORE DELETE ON `sales_sale_cancellation_lines` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_sale_cancellation_lines : suppression physique interdite (INV-GLO-03).';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `sales_sale_cancellations`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `sales_sale_cancellations` (
  `id` binary(16) NOT NULL,
  `doc_number` varchar(40) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `local_ref` varchar(20) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `site_id` binary(16) NOT NULL,
  `sale_id` binary(16) NOT NULL,
  `order_id` binary(16) DEFAULT NULL,
  `cause` varchar(25) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `status` varchar(15) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `reason_code_id` binary(16) DEFAULT NULL,
  `comment` text COLLATE utf8mb4_0900_as_cs,
  `requested_by` binary(16) NOT NULL,
  `approval_request_id` binary(16) DEFAULT NULL,
  `cancelled_total_xaf` bigint NOT NULL,
  `released_payment_treatment` varchar(20) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `applied_at` datetime(6) DEFAULT NULL,
  `applied_business_date` date GENERATED ALWAYS AS (cast(convert_tz(`applied_at`,_utf8mb4'+00:00',_utf8mb4'+01:00') as date)) STORED,
  `occurred_at` datetime(6) NOT NULL,
  `client_created_at` datetime(6) DEFAULT NULL,
  `received_at_server` datetime(6) DEFAULT NULL,
  `command_id` binary(16) DEFAULT NULL,
  `created_device_id` binary(16) DEFAULT NULL,
  `captured_offline` tinyint(1) NOT NULL DEFAULT '0',
  `clock_suspect` tinyint(1) NOT NULL DEFAULT '0',
  `backdated_reason` text COLLATE utf8mb4_0900_as_cs,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `updated_by` binary(16) DEFAULT NULL,
  `version` int NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_sales_sale_cancellations_doc_number` (`doc_number`),
  UNIQUE KEY `uq_sales_sale_cancellations_device_ref` (`created_device_id`,`local_ref`),
  UNIQUE KEY `uq_sales_sale_cancellations_command_sale` (`command_id`,`sale_id`),
  KEY `ix_sales_sale_cancellations_sale` (`sale_id`,`status`),
  KEY `ix_sales_sale_cancellations_order` (`order_id`),
  KEY `ix_sales_sale_cancellations_applied` (`applied_at`),
  KEY `fk_sales_sale_cancellations_reason` (`reason_code_id`),
  KEY `fk_sales_sale_cancellations_requested_by` (`requested_by`),
  KEY `fk_sales_sale_cancellations_approval` (`approval_request_id`),
  KEY `fk_sales_sale_cancellations_created_by` (`created_by`),
  KEY `fk_sales_sale_cancellations_updated_by` (`updated_by`),
  KEY `ix_sales_sale_cancellations_applied_date` (`site_id`,`applied_business_date`),
  CONSTRAINT `fk_sales_sale_cancellations_approval` FOREIGN KEY (`approval_request_id`) REFERENCES `approvals_approval_requests` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_sale_cancellations_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_sale_cancellations_created_device` FOREIGN KEY (`created_device_id`) REFERENCES `identity_devices` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_sale_cancellations_order` FOREIGN KEY (`order_id`) REFERENCES `sales_sales_orders` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_sale_cancellations_reason` FOREIGN KEY (`reason_code_id`) REFERENCES `catalog_reason_codes` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_sale_cancellations_requested_by` FOREIGN KEY (`requested_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_sale_cancellations_sale` FOREIGN KEY (`sale_id`) REFERENCES `sales_sales` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_sale_cancellations_site` FOREIGN KEY (`site_id`) REFERENCES `organization_sites` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_sale_cancellations_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_sales_sale_cancellations_applied` CHECK (((`status` = _utf8mb4'APPLIED') = (`applied_at` is not null))),
  CONSTRAINT `ck_sales_sale_cancellations_cause` CHECK ((`cause` in (_utf8mb4'SALE_CANCELLATION',_utf8mb4'ORDER_CANCELLATION',_utf8mb4'ORDER_CLOSURE',_utf8mb4'ORDER_ADJUSTMENT'))),
  CONSTRAINT `ck_sales_sale_cancellations_order_cause` CHECK (((`cause` = _utf8mb4'SALE_CANCELLATION') or (`order_id` is not null))),
  CONSTRAINT `ck_sales_sale_cancellations_status` CHECK ((`status` in (_utf8mb4'REQUESTED',_utf8mb4'APPLIED',_utf8mb4'REJECTED'))),
  CONSTRAINT `ck_sales_sale_cancellations_total` CHECK ((`cancelled_total_xaf` >= 0)),
  CONSTRAINT `ck_sales_sale_cancellations_treatment` CHECK (((`released_payment_treatment` is null) or (`released_payment_treatment` in (_utf8mb4'CUSTOMER_CREDIT',_utf8mb4'REFUND'))))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_sales_sale_cancellations_update_guard` BEFORE UPDATE ON `sales_sale_cancellations` FOR EACH ROW BEGIN
  IF NOT (
    NEW.doc_number <=> OLD.doc_number AND
    NEW.local_ref <=> OLD.local_ref AND
    NEW.site_id <=> OLD.site_id AND
    NEW.sale_id <=> OLD.sale_id AND
    NEW.order_id <=> OLD.order_id AND
    NEW.cause <=> OLD.cause AND
    NEW.reason_code_id <=> OLD.reason_code_id AND
    NEW.comment <=> OLD.comment AND
    NEW.requested_by <=> OLD.requested_by AND
    NEW.cancelled_total_xaf <=> OLD.cancelled_total_xaf AND
    NEW.occurred_at <=> OLD.occurred_at AND
    NEW.client_created_at <=> OLD.client_created_at AND
    NEW.received_at_server <=> OLD.received_at_server AND
    NEW.command_id <=> OLD.command_id AND
    NEW.created_device_id <=> OLD.created_device_id AND
    NEW.captured_offline <=> OLD.captured_offline AND
    NEW.clock_suspect <=> OLD.clock_suspect AND
    NEW.backdated_reason <=> OLD.backdated_reason AND
    NEW.created_at <=> OLD.created_at AND
    NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_sale_cancellations : document d''annulation immuable ; seuls statut et sort des paiements évoluent.';
  END IF;
  -- La date d'effet porte la diminution du chiffre d'affaires (BR-FIN-042) : elle ne se réécrit pas.
  IF OLD.status <> 'REQUESTED' AND (
    NEW.status <> OLD.status OR NOT (NEW.applied_at <=> OLD.applied_at)
    OR NOT (NEW.approval_request_id <=> OLD.approval_request_id)
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_sale_cancellations : une annulation appliquée ou rejetée ne change plus de statut ni de date d''effet.';
  END IF;
  IF OLD.released_payment_treatment IS NOT NULL AND NOT (NEW.released_payment_treatment <=> OLD.released_payment_treatment) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_sale_cancellations : le sort du paiement libéré s''écrit une seule fois.';
  END IF;
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_sales_sale_cancellations_no_delete` BEFORE DELETE ON `sales_sale_cancellations` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_sale_cancellations : suppression physique interdite (INV-GLO-03).';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `sales_sale_lines`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `sales_sale_lines` (
  `id` binary(16) NOT NULL,
  `sale_id` binary(16) NOT NULL,
  `line_no` smallint NOT NULL,
  `order_line_id` binary(16) DEFAULT NULL,
  `product_id` binary(16) NOT NULL,
  `product_name_snapshot` varchar(200) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `quantity` decimal(14,3) NOT NULL,
  `unit_code` varchar(20) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `quantity_base` decimal(14,3) NOT NULL,
  `pricing_quantity` decimal(14,3) NOT NULL,
  `pricing_unit_code` varchar(20) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `list_unit_price_xaf` bigint DEFAULT NULL,
  `unit_price_xaf` bigint NOT NULL,
  `price_rule_id` binary(16) DEFAULT NULL,
  `price_rule_version` int DEFAULT NULL,
  `price_specificity` smallint DEFAULT NULL,
  `price_source` varchar(20) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `override_reason_code_id` binary(16) DEFAULT NULL,
  `override_approval_request_id` binary(16) DEFAULT NULL,
  `discount_xaf` bigint NOT NULL DEFAULT '0',
  `tax_rate` decimal(7,4) NOT NULL DEFAULT '0.0000',
  `line_total_xaf` bigint NOT NULL,
  `cancelled_quantity_base` decimal(14,3) NOT NULL DEFAULT '0.000',
  `cancelled_xaf` bigint NOT NULL DEFAULT '0',
  `delivered_quantity_base` decimal(14,3) NOT NULL DEFAULT '0.000',
  `unit_cost_xaf` bigint DEFAULT NULL,
  `cost_xaf` bigint DEFAULT NULL,
  `allocation_id` binary(16) DEFAULT NULL,
  `client_lot_hint` binary(16) DEFAULT NULL,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_sales_sale_lines_line_no` (`sale_id`,`line_no`),
  KEY `ix_sales_sale_lines_product` (`product_id`),
  KEY `ix_sales_sale_lines_order_line` (`order_line_id`),
  KEY `ix_sales_sale_lines_price_rule` (`price_rule_id`),
  KEY `fk_sales_sale_lines_unit` (`unit_code`),
  KEY `fk_sales_sale_lines_pricing_unit` (`pricing_unit_code`),
  KEY `fk_sales_sale_lines_override_reason` (`override_reason_code_id`),
  KEY `fk_sales_sale_lines_override_approval` (`override_approval_request_id`),
  KEY `fk_sales_sale_lines_allocation` (`allocation_id`),
  CONSTRAINT `fk_sales_sale_lines_allocation` FOREIGN KEY (`allocation_id`) REFERENCES `inventory_stock_allocations` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_sale_lines_order_line` FOREIGN KEY (`order_line_id`) REFERENCES `sales_sales_order_lines` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_sale_lines_override_approval` FOREIGN KEY (`override_approval_request_id`) REFERENCES `approvals_approval_requests` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_sale_lines_override_reason` FOREIGN KEY (`override_reason_code_id`) REFERENCES `catalog_reason_codes` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_sale_lines_price_rule` FOREIGN KEY (`price_rule_id`) REFERENCES `pricing_price_rules` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_sale_lines_pricing_unit` FOREIGN KEY (`pricing_unit_code`) REFERENCES `catalog_units` (`code`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_sale_lines_product` FOREIGN KEY (`product_id`) REFERENCES `catalog_products` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_sale_lines_sale` FOREIGN KEY (`sale_id`) REFERENCES `sales_sales` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_sale_lines_unit` FOREIGN KEY (`unit_code`) REFERENCES `catalog_units` (`code`) ON DELETE RESTRICT,
  CONSTRAINT `ck_sales_sale_lines_cancelled` CHECK (((`cancelled_quantity_base` >= 0) and (`cancelled_quantity_base` <= `quantity_base`) and (`cancelled_xaf` >= 0) and (`cancelled_xaf` <= `line_total_xaf`) and ((`cancelled_quantity_base` < `quantity_base`) or (`cancelled_xaf` = `line_total_xaf`)))),
  CONSTRAINT `ck_sales_sale_lines_cancelled_amount` CHECK (((`cancelled_quantity_base` > 0) or (`cancelled_xaf` = 0))),
  CONSTRAINT `ck_sales_sale_lines_cost` CHECK ((((`unit_cost_xaf` is null) or (`unit_cost_xaf` >= 0)) and ((`cost_xaf` is null) or (`cost_xaf` >= 0)))),
  CONSTRAINT `ck_sales_sale_lines_delivered` CHECK (((`delivered_quantity_base` >= 0) and (`delivered_quantity_base` <= (`quantity_base` - `cancelled_quantity_base`)))),
  CONSTRAINT `ck_sales_sale_lines_override` CHECK (((`price_source` <> _utf8mb4'MANUAL_OVERRIDE') or (`override_reason_code_id` is not null))),
  CONSTRAINT `ck_sales_sale_lines_price_source` CHECK ((`price_source` in (_utf8mb4'RULE',_utf8mb4'ORDER_QUOTE',_utf8mb4'MANUAL_OVERRIDE'))),
  CONSTRAINT `ck_sales_sale_lines_prices` CHECK (((`unit_price_xaf` >= 0) and (`discount_xaf` >= 0) and (`tax_rate` >= 0) and (`tax_rate` <= 1) and ((`list_unit_price_xaf` is null) or (`list_unit_price_xaf` >= 0)))),
  CONSTRAINT `ck_sales_sale_lines_quantities` CHECK (((`quantity` > 0) and (`quantity_base` > 0) and (`pricing_quantity` > 0))),
  CONSTRAINT `ck_sales_sale_lines_quote` CHECK (((`price_source` <> _utf8mb4'ORDER_QUOTE') or (`order_line_id` is not null))),
  CONSTRAINT `ck_sales_sale_lines_rule` CHECK (((`price_source` <> _utf8mb4'RULE') or ((`price_rule_id` is not null) and (`price_rule_version` is not null) and (`list_unit_price_xaf` is not null)))),
  CONSTRAINT `ck_sales_sale_lines_total` CHECK (((`line_total_xaf` >= 0) and (`line_total_xaf` = (round((`pricing_quantity` * `unit_price_xaf`),0) - `discount_xaf`))))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_sales_sale_lines_update_guard` BEFORE UPDATE ON `sales_sale_lines` FOR EACH ROW BEGIN
  IF NOT (
    NEW.sale_id <=> OLD.sale_id AND
    NEW.line_no <=> OLD.line_no AND
    NEW.order_line_id <=> OLD.order_line_id AND
    NEW.product_id <=> OLD.product_id AND
    NEW.product_name_snapshot <=> OLD.product_name_snapshot AND
    NEW.quantity <=> OLD.quantity AND
    NEW.unit_code <=> OLD.unit_code AND
    NEW.quantity_base <=> OLD.quantity_base AND
    NEW.pricing_quantity <=> OLD.pricing_quantity AND
    NEW.pricing_unit_code <=> OLD.pricing_unit_code AND
    NEW.list_unit_price_xaf <=> OLD.list_unit_price_xaf AND
    NEW.unit_price_xaf <=> OLD.unit_price_xaf AND
    NEW.price_rule_id <=> OLD.price_rule_id AND
    NEW.price_rule_version <=> OLD.price_rule_version AND
    NEW.price_specificity <=> OLD.price_specificity AND
    NEW.price_source <=> OLD.price_source AND
    NEW.override_reason_code_id <=> OLD.override_reason_code_id AND
    NEW.override_approval_request_id <=> OLD.override_approval_request_id AND
    NEW.discount_xaf <=> OLD.discount_xaf AND
    NEW.tax_rate <=> OLD.tax_rate AND
    NEW.line_total_xaf <=> OLD.line_total_xaf AND
    NEW.allocation_id <=> OLD.allocation_id AND
    NEW.client_lot_hint <=> OLD.client_lot_hint AND
    NEW.created_at <=> OLD.created_at
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_sale_lines : ligne de vente immuable (INV-VEN-02) ; seuls annulé, livré et coût évoluent.';
  END IF;
  IF NEW.cancelled_quantity_base < OLD.cancelled_quantity_base OR NEW.cancelled_xaf < OLD.cancelled_xaf
     OR NEW.delivered_quantity_base < OLD.delivered_quantity_base THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_sale_lines : les quantités annulée et livrée ne diminuent jamais.';
  END IF;
  IF (OLD.cost_xaf IS NOT NULL AND NOT (NEW.cost_xaf <=> OLD.cost_xaf))
     OR (OLD.unit_cost_xaf IS NOT NULL AND NOT (NEW.unit_cost_xaf <=> OLD.unit_cost_xaf)) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_sale_lines : le coût figé de la ligne ne change plus (ADR-025 §4).';
  END IF;
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_sales_sale_lines_no_delete` BEFORE DELETE ON `sales_sale_lines` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_sale_lines : suppression physique interdite (INV-GLO-03).';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `sales_sales`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `sales_sales` (
  `id` binary(16) NOT NULL,
  `doc_number` varchar(40) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `local_ref` varchar(20) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `site_id` binary(16) NOT NULL,
  `sale_type` varchar(10) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `order_id` binary(16) DEFAULT NULL,
  `customer_id` binary(16) DEFAULT NULL,
  `customer_category_id_snapshot` binary(16) DEFAULT NULL,
  `channel_code` varchar(20) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `from_location_id` binary(16) NOT NULL,
  `to_deliver_location_id` binary(16) DEFAULT NULL,
  `zone_id` binary(16) NOT NULL,
  `seller_user_id` binary(16) NOT NULL,
  `commercial_user_id` binary(16) DEFAULT NULL,
  `work_session_id` binary(16) DEFAULT NULL,
  `cash_session_id` binary(16) DEFAULT NULL,
  `lat` decimal(9,6) DEFAULT NULL,
  `lng` decimal(9,6) DEFAULT NULL,
  `accuracy_m` decimal(8,1) DEFAULT NULL,
  `status` varchar(25) COLLATE utf8mb4_0900_as_cs NOT NULL DEFAULT 'CONFIRMED',
  `subtotal_xaf` bigint NOT NULL,
  `discount_total_xaf` bigint NOT NULL DEFAULT '0',
  `tax_total_xaf` bigint NOT NULL DEFAULT '0',
  `total_xaf` bigint NOT NULL,
  `cancelled_xaf` bigint NOT NULL DEFAULT '0',
  `amount_paid_xaf` bigint NOT NULL DEFAULT '0',
  `net_total_xaf` bigint GENERATED ALWAYS AS ((`total_xaf` - `cancelled_xaf`)) STORED,
  `balance_due_xaf` bigint GENERATED ALWAYS AS (((`total_xaf` - `cancelled_xaf`) - `amount_paid_xaf`)) STORED,
  `payment_status` varchar(15) COLLATE utf8mb4_0900_as_cs GENERATED ALWAYS AS ((case when (((`total_xaf` - `cancelled_xaf`) - `amount_paid_xaf`) = 0) then _utf8mb4'PAID' when (`amount_paid_xaf` = 0) then _utf8mb4'UNPAID' else _utf8mb4'PARTIALLY_PAID' end)) STORED,
  `due_date` date DEFAULT NULL,
  `flags` json NOT NULL DEFAULT (json_array()),
  `occurred_at` datetime(6) NOT NULL,
  `business_date` date GENERATED ALWAYS AS (cast(convert_tz(`occurred_at`,_utf8mb4'+00:00',_utf8mb4'+01:00') as date)) STORED,
  `client_created_at` datetime(6) DEFAULT NULL,
  `received_at_server` datetime(6) DEFAULT NULL,
  `command_id` binary(16) DEFAULT NULL,
  `created_device_id` binary(16) DEFAULT NULL,
  `captured_offline` tinyint(1) NOT NULL DEFAULT '0',
  `clock_suspect` tinyint(1) NOT NULL DEFAULT '0',
  `backdated_reason` text COLLATE utf8mb4_0900_as_cs,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `updated_by` binary(16) DEFAULT NULL,
  `version` int NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_sales_sales_doc_number` (`doc_number`),
  UNIQUE KEY `uq_sales_sales_command` (`command_id`),
  UNIQUE KEY `uq_sales_sales_device_ref` (`created_device_id`,`local_ref`),
  KEY `ix_sales_sales_occurred_at` (`occurred_at`),
  KEY `ix_sales_sales_business_date` (`business_date`,`from_location_id`),
  KEY `ix_sales_sales_site_date` (`site_id`,`business_date`),
  KEY `ix_sales_sales_customer` (`customer_id`,`occurred_at`),
  KEY `ix_sales_sales_commercial` (`commercial_user_id`,`business_date`),
  KEY `ix_sales_sales_seller` (`seller_user_id`,`business_date`),
  KEY `ix_sales_sales_order` (`order_id`),
  KEY `ix_sales_sales_payment_status` (`payment_status`,`due_date`),
  KEY `fk_sales_sales_channel` (`channel_code`),
  KEY `fk_sales_sales_from_location` (`from_location_id`),
  KEY `fk_sales_sales_to_deliver_location` (`to_deliver_location_id`),
  KEY `fk_sales_sales_zone` (`zone_id`),
  KEY `fk_sales_sales_work_session` (`work_session_id`),
  KEY `fk_sales_sales_created_by` (`created_by`),
  KEY `fk_sales_sales_updated_by` (`updated_by`),
  KEY `ix_sales_sales_cash_session` (`cash_session_id`),
  CONSTRAINT `fk_sales_sales_channel` FOREIGN KEY (`channel_code`) REFERENCES `catalog_sales_channels` (`code`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_sales_commercial` FOREIGN KEY (`commercial_user_id`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_sales_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_sales_created_device` FOREIGN KEY (`created_device_id`) REFERENCES `identity_devices` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_sales_customer` FOREIGN KEY (`customer_id`) REFERENCES `crm_customers` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_sales_from_location` FOREIGN KEY (`from_location_id`) REFERENCES `organization_locations` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_sales_order` FOREIGN KEY (`order_id`) REFERENCES `sales_sales_orders` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_sales_seller` FOREIGN KEY (`seller_user_id`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_sales_site` FOREIGN KEY (`site_id`) REFERENCES `organization_sites` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_sales_to_deliver_location` FOREIGN KEY (`to_deliver_location_id`) REFERENCES `organization_locations` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_sales_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_sales_work_session` FOREIGN KEY (`work_session_id`) REFERENCES `fieldwork_work_sessions` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_sales_zone` FOREIGN KEY (`zone_id`) REFERENCES `organization_zones` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_sales_sales_amounts` CHECK (((`subtotal_xaf` >= 0) and (`discount_total_xaf` >= 0) and (`tax_total_xaf` >= 0) and (`total_xaf` >= 0))),
  CONSTRAINT `ck_sales_sales_cancelled` CHECK (((`cancelled_xaf` >= 0) and (`cancelled_xaf` <= `total_xaf`))),
  CONSTRAINT `ck_sales_sales_cancelled_status` CHECK (((`status` <> _utf8mb4'CANCELLED') or (`cancelled_xaf` = `total_xaf`))),
  CONSTRAINT `ck_sales_sales_order_customer` CHECK (((`sale_type` <> _utf8mb4'ORDER') or (`customer_id` is not null))),
  CONSTRAINT `ck_sales_sales_order_link` CHECK ((((`sale_type` = _utf8mb4'ORDER') and (`order_id` is not null) and (`to_deliver_location_id` is not null)) or ((`sale_type` = _utf8mb4'DIRECT') and (`order_id` is null) and (`to_deliver_location_id` is null)))),
  CONSTRAINT `ck_sales_sales_paid` CHECK (((`amount_paid_xaf` >= 0) and (`amount_paid_xaf` <= (`total_xaf` - `cancelled_xaf`)))),
  CONSTRAINT `ck_sales_sales_status` CHECK ((`status` in (_utf8mb4'CONFIRMED',_utf8mb4'CANCELLATION_REQUESTED',_utf8mb4'CANCELLED'))),
  CONSTRAINT `ck_sales_sales_total` CHECK ((`total_xaf` = ((`subtotal_xaf` - `discount_total_xaf`) + `tax_total_xaf`))),
  CONSTRAINT `ck_sales_sales_type` CHECK ((`sale_type` in (_utf8mb4'DIRECT',_utf8mb4'ORDER')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_sales_sales_insert_guard` BEFORE INSERT ON `sales_sales` FOR EACH ROW BEGIN
  DECLARE td_type VARCHAR(20);
  DECLARE td_site BINARY(16);
  DECLARE from_site BINARY(16);
  -- ADR-028 §1 : l'emplacement « à livrer » d'une vente sur commande est celui du site de la préparation.
  IF NEW.to_deliver_location_id IS NOT NULL THEN
    SELECT location_type, site_id INTO td_type, td_site FROM organization_locations WHERE id = NEW.to_deliver_location_id;
    SELECT site_id INTO from_site FROM organization_locations WHERE id = NEW.from_location_id;
    IF td_type IS NULL OR td_type <> 'V_TO_DELIVER' OR from_site IS NULL OR td_site <> from_site THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_sales : « à livrer » doit être celui du site de l''emplacement de préparation (ADR-028 §1).';
    END IF;
  END IF;
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_sales_sales_update_guard` BEFORE UPDATE ON `sales_sales` FOR EACH ROW BEGIN
  IF NOT (
    NEW.doc_number <=> OLD.doc_number AND
    NEW.local_ref <=> OLD.local_ref AND
    NEW.site_id <=> OLD.site_id AND
    NEW.sale_type <=> OLD.sale_type AND
    NEW.order_id <=> OLD.order_id AND
    NEW.customer_id <=> OLD.customer_id AND
    NEW.customer_category_id_snapshot <=> OLD.customer_category_id_snapshot AND
    NEW.channel_code <=> OLD.channel_code AND
    NEW.from_location_id <=> OLD.from_location_id AND
    NEW.to_deliver_location_id <=> OLD.to_deliver_location_id AND
    NEW.zone_id <=> OLD.zone_id AND
    NEW.seller_user_id <=> OLD.seller_user_id AND
    NEW.commercial_user_id <=> OLD.commercial_user_id AND
    NEW.work_session_id <=> OLD.work_session_id AND
    NEW.lat <=> OLD.lat AND
    NEW.lng <=> OLD.lng AND
    NEW.accuracy_m <=> OLD.accuracy_m AND
    NEW.subtotal_xaf <=> OLD.subtotal_xaf AND
    NEW.discount_total_xaf <=> OLD.discount_total_xaf AND
    NEW.tax_total_xaf <=> OLD.tax_total_xaf AND
    NEW.total_xaf <=> OLD.total_xaf AND
    NEW.due_date <=> OLD.due_date AND
    NEW.occurred_at <=> OLD.occurred_at AND
    NEW.client_created_at <=> OLD.client_created_at AND
    NEW.received_at_server <=> OLD.received_at_server AND
    NEW.command_id <=> OLD.command_id AND
    NEW.created_device_id <=> OLD.created_device_id AND
    NEW.captured_offline <=> OLD.captured_offline AND
    NEW.clock_suspect <=> OLD.clock_suspect AND
    NEW.backdated_reason <=> OLD.backdated_reason AND
    NEW.created_at <=> OLD.created_at AND
    NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_sales : vente immuable (INV-VEN-02) ; corriger par un document d''annulation.';
  END IF;
  IF NEW.cancelled_xaf < OLD.cancelled_xaf THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_sales : le montant annulé ne diminue jamais (contre-écriture, ADR-028 §5).';
  END IF;
  IF OLD.status = 'CANCELLED' AND NEW.status <> 'CANCELLED' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_sales : une vente annulée ne revient pas à CONFIRMED (SM-SALE).';
  END IF;
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_sales_sales_no_delete` BEFORE DELETE ON `sales_sales` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_sales : suppression physique interdite (INV-GLO-03) ; annuler par contre-écriture.';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `sales_sales_order_lines`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `sales_sales_order_lines` (
  `id` binary(16) NOT NULL,
  `order_id` binary(16) NOT NULL,
  `line_no` smallint NOT NULL,
  `product_id` binary(16) NOT NULL,
  `product_name_snapshot` varchar(200) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `quantity` decimal(14,3) NOT NULL,
  `unit_code` varchar(20) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `quantity_base` decimal(14,3) NOT NULL,
  `withdrawn_quantity_base` decimal(14,3) NOT NULL DEFAULT '0.000',
  `sold_quantity_base` decimal(14,3) NOT NULL DEFAULT '0.000',
  `delivered_quantity_base` decimal(14,3) NOT NULL DEFAULT '0.000',
  `quoted_unit_price_xaf` bigint NOT NULL,
  `list_unit_price_xaf` bigint DEFAULT NULL,
  `price_rule_id` binary(16) DEFAULT NULL,
  `price_rule_version` int DEFAULT NULL,
  `price_source` varchar(20) COLLATE utf8mb4_0900_as_cs NOT NULL DEFAULT 'RULE',
  `override_reason_code_id` binary(16) DEFAULT NULL,
  `override_approval_request_id` binary(16) DEFAULT NULL,
  `line_total_xaf` bigint NOT NULL,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_sales_sales_order_lines_line_no` (`order_id`,`line_no`),
  KEY `ix_sales_sales_order_lines_product` (`product_id`),
  KEY `fk_sales_sales_order_lines_unit` (`unit_code`),
  KEY `fk_sales_sales_order_lines_price_rule` (`price_rule_id`),
  KEY `fk_sales_sales_order_lines_override_reason` (`override_reason_code_id`),
  KEY `fk_sales_sales_order_lines_override_approval` (`override_approval_request_id`),
  CONSTRAINT `fk_sales_sales_order_lines_order` FOREIGN KEY (`order_id`) REFERENCES `sales_sales_orders` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_sales_order_lines_override_approval` FOREIGN KEY (`override_approval_request_id`) REFERENCES `approvals_approval_requests` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_sales_order_lines_override_reason` FOREIGN KEY (`override_reason_code_id`) REFERENCES `catalog_reason_codes` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_sales_order_lines_price_rule` FOREIGN KEY (`price_rule_id`) REFERENCES `pricing_price_rules` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_sales_order_lines_product` FOREIGN KEY (`product_id`) REFERENCES `catalog_products` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_sales_order_lines_unit` FOREIGN KEY (`unit_code`) REFERENCES `catalog_units` (`code`) ON DELETE RESTRICT,
  CONSTRAINT `ck_sales_sales_order_lines_amounts` CHECK (((`quoted_unit_price_xaf` >= 0) and (`line_total_xaf` >= 0))),
  CONSTRAINT `ck_sales_sales_order_lines_list_price` CHECK (((`list_unit_price_xaf` is null) or (`list_unit_price_xaf` >= 0))),
  CONSTRAINT `ck_sales_sales_order_lines_override` CHECK (((`price_source` <> _utf8mb4'MANUAL_OVERRIDE') or (`override_reason_code_id` is not null))),
  CONSTRAINT `ck_sales_sales_order_lines_price_source` CHECK ((`price_source` in (_utf8mb4'RULE',_utf8mb4'MANUAL_OVERRIDE'))),
  CONSTRAINT `ck_sales_sales_order_lines_quantities` CHECK (((`quantity` >= 0) and (`quantity_base` >= 0) and (`withdrawn_quantity_base` >= 0) and (`delivered_quantity_base` >= 0) and (`delivered_quantity_base` <= `sold_quantity_base`) and (`sold_quantity_base` <= `quantity_base`)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_sales_sales_order_lines_update_guard` BEFORE UPDATE ON `sales_sales_order_lines` FOR EACH ROW BEGIN
  IF NOT (
    NEW.order_id <=> OLD.order_id AND
    NEW.line_no <=> OLD.line_no AND
    NEW.product_id <=> OLD.product_id AND
    NEW.product_name_snapshot <=> OLD.product_name_snapshot AND
    NEW.unit_code <=> OLD.unit_code AND
    NEW.quoted_unit_price_xaf <=> OLD.quoted_unit_price_xaf AND
    NEW.list_unit_price_xaf <=> OLD.list_unit_price_xaf AND
    NEW.price_rule_id <=> OLD.price_rule_id AND
    NEW.price_rule_version <=> OLD.price_rule_version AND
    NEW.price_source <=> OLD.price_source AND
    NEW.override_reason_code_id <=> OLD.override_reason_code_id AND
    NEW.override_approval_request_id <=> OLD.override_approval_request_id AND
    NEW.created_at <=> OLD.created_at
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_sales_order_lines : produit, unité et prix convenu immuables ; seules les quantités évoluent.';
  END IF;
  -- Le vendu net baisse à une annulation, le commandé à un retrait : seuls le livré (un fait) et
  -- le cumul retiré sont monotones.
  IF NEW.delivered_quantity_base < OLD.delivered_quantity_base THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_sales_order_lines : la quantité livrée ne diminue jamais (INV-VEN-04).';
  END IF;
  IF NEW.withdrawn_quantity_base < OLD.withdrawn_quantity_base THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_sales_order_lines : la quantité retirée ne diminue jamais (traçabilité).';
  END IF;
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_sales_sales_order_lines_no_delete` BEFORE DELETE ON `sales_sales_order_lines` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_sales_order_lines : suppression physique interdite (INV-GLO-03).';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `sales_sales_orders`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `sales_sales_orders` (
  `id` binary(16) NOT NULL,
  `doc_number` varchar(40) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `local_ref` varchar(20) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `site_id` binary(16) NOT NULL,
  `customer_id` binary(16) NOT NULL,
  `commercial_user_id` binary(16) NOT NULL,
  `channel_code` varchar(20) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `fulfilment_location_id` binary(16) NOT NULL,
  `requested_delivery_date` date DEFAULT NULL,
  `delivery_address` text COLLATE utf8mb4_0900_as_cs,
  `status` varchar(20) COLLATE utf8mb4_0900_as_cs NOT NULL DEFAULT 'CONFIRMED',
  `total_estimated_xaf` bigint NOT NULL DEFAULT '0',
  `advance_paid_xaf` bigint NOT NULL DEFAULT '0',
  `external_origin` varchar(10) COLLATE utf8mb4_0900_as_cs NOT NULL DEFAULT 'NONE',
  `confirmed_at` datetime(6) DEFAULT NULL,
  `closed_at` datetime(6) DEFAULT NULL,
  `closed_by` binary(16) DEFAULT NULL,
  `closed_reason` text COLLATE utf8mb4_0900_as_cs,
  `released_payment_treatment` varchar(20) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `cancelled_at` datetime(6) DEFAULT NULL,
  `cancelled_by` binary(16) DEFAULT NULL,
  `cancel_reason_code_id` binary(16) DEFAULT NULL,
  `cancel_comment` text COLLATE utf8mb4_0900_as_cs,
  `cancel_approval_request_id` binary(16) DEFAULT NULL,
  `occurred_at` datetime(6) NOT NULL,
  `client_created_at` datetime(6) DEFAULT NULL,
  `received_at_server` datetime(6) DEFAULT NULL,
  `command_id` binary(16) DEFAULT NULL,
  `created_device_id` binary(16) DEFAULT NULL,
  `captured_offline` tinyint(1) NOT NULL DEFAULT '0',
  `clock_suspect` tinyint(1) NOT NULL DEFAULT '0',
  `backdated_reason` text COLLATE utf8mb4_0900_as_cs,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by` binary(16) NOT NULL,
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `updated_by` binary(16) DEFAULT NULL,
  `version` int NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_sales_sales_orders_doc_number` (`doc_number`),
  UNIQUE KEY `uq_sales_sales_orders_command` (`command_id`),
  UNIQUE KEY `uq_sales_sales_orders_device_ref` (`created_device_id`,`local_ref`),
  KEY `ix_sales_sales_orders_customer` (`customer_id`,`occurred_at`),
  KEY `ix_sales_sales_orders_commercial` (`commercial_user_id`,`occurred_at`),
  KEY `ix_sales_sales_orders_location_status` (`fulfilment_location_id`,`status`),
  KEY `ix_sales_sales_orders_status` (`status`,`site_id`),
  KEY `fk_sales_sales_orders_site` (`site_id`),
  KEY `fk_sales_sales_orders_channel` (`channel_code`),
  KEY `fk_sales_sales_orders_closed_by` (`closed_by`),
  KEY `fk_sales_sales_orders_cancelled_by` (`cancelled_by`),
  KEY `fk_sales_sales_orders_cancel_reason` (`cancel_reason_code_id`),
  KEY `fk_sales_sales_orders_cancel_approval` (`cancel_approval_request_id`),
  KEY `fk_sales_sales_orders_created_by` (`created_by`),
  KEY `fk_sales_sales_orders_updated_by` (`updated_by`),
  CONSTRAINT `fk_sales_sales_orders_cancel_approval` FOREIGN KEY (`cancel_approval_request_id`) REFERENCES `approvals_approval_requests` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_sales_orders_cancel_reason` FOREIGN KEY (`cancel_reason_code_id`) REFERENCES `catalog_reason_codes` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_sales_orders_cancelled_by` FOREIGN KEY (`cancelled_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_sales_orders_channel` FOREIGN KEY (`channel_code`) REFERENCES `catalog_sales_channels` (`code`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_sales_orders_closed_by` FOREIGN KEY (`closed_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_sales_orders_commercial` FOREIGN KEY (`commercial_user_id`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_sales_orders_created_by` FOREIGN KEY (`created_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_sales_orders_created_device` FOREIGN KEY (`created_device_id`) REFERENCES `identity_devices` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_sales_orders_customer` FOREIGN KEY (`customer_id`) REFERENCES `crm_customers` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_sales_orders_location` FOREIGN KEY (`fulfilment_location_id`) REFERENCES `organization_locations` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_sales_orders_site` FOREIGN KEY (`site_id`) REFERENCES `organization_sites` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_sales_orders_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_sales_sales_orders_amounts` CHECK (((`total_estimated_xaf` >= 0) and (`advance_paid_xaf` >= 0))),
  CONSTRAINT `ck_sales_sales_orders_cancel` CHECK ((((`status` = _utf8mb4'CANCELLED') and (`cancelled_at` is not null) and (`cancelled_by` is not null)) or ((`status` <> _utf8mb4'CANCELLED') and (`cancelled_at` is null) and (`cancelled_by` is null) and (`cancel_reason_code_id` is null) and (`cancel_comment` is null) and (`cancel_approval_request_id` is null)))),
  CONSTRAINT `ck_sales_sales_orders_closed` CHECK ((((`status` = _utf8mb4'CLOSED') and (`closed_at` is not null) and (`closed_by` is not null)) or ((`status` <> _utf8mb4'CLOSED') and (`closed_at` is null) and (`closed_by` is null)))),
  CONSTRAINT `ck_sales_sales_orders_confirmed` CHECK (((`status` in (_utf8mb4'DRAFT',_utf8mb4'CANCELLED')) or (`confirmed_at` is not null))),
  CONSTRAINT `ck_sales_sales_orders_origin` CHECK ((`external_origin` in (_utf8mb4'NONE',_utf8mb4'KOMMO'))),
  CONSTRAINT `ck_sales_sales_orders_status` CHECK ((`status` in (_utf8mb4'DRAFT',_utf8mb4'CONFIRMED',_utf8mb4'PARTIALLY_FULFILLED',_utf8mb4'FULFILLED',_utf8mb4'CLOSED',_utf8mb4'CANCELLED'))),
  CONSTRAINT `ck_sales_sales_orders_treatment` CHECK (((`released_payment_treatment` is null) or (`released_payment_treatment` in (_utf8mb4'CUSTOMER_CREDIT',_utf8mb4'REFUND'))))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_sales_sales_orders_update_guard` BEFORE UPDATE ON `sales_sales_orders` FOR EACH ROW BEGIN
  IF NOT (
    NEW.doc_number <=> OLD.doc_number AND
    NEW.local_ref <=> OLD.local_ref AND
    NEW.site_id <=> OLD.site_id AND
    NEW.customer_id <=> OLD.customer_id AND
    NEW.commercial_user_id <=> OLD.commercial_user_id AND
    NEW.channel_code <=> OLD.channel_code AND
    NEW.external_origin <=> OLD.external_origin AND
    NEW.occurred_at <=> OLD.occurred_at AND
    NEW.client_created_at <=> OLD.client_created_at AND
    NEW.received_at_server <=> OLD.received_at_server AND
    NEW.command_id <=> OLD.command_id AND
    NEW.created_device_id <=> OLD.created_device_id AND
    NEW.captured_offline <=> OLD.captured_offline AND
    NEW.clock_suspect <=> OLD.clock_suspect AND
    NEW.backdated_reason <=> OLD.backdated_reason AND
    NEW.created_at <=> OLD.created_at AND
    NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_sales_orders : identité de la commande immuable ; seuls lieu, dates, totaux, statut et clôture évoluent.';
  END IF;
  IF OLD.status IN ('FULFILLED', 'CLOSED', 'CANCELLED') AND NEW.status <> OLD.status THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_sales_orders : commande terminée, son statut ne change plus (SM-ORDER).';
  END IF;
  IF OLD.status <> 'DRAFT' AND NEW.status = 'DRAFT' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_sales_orders : une commande confirmée ne redevient pas brouillon (SM-ORDER).';
  END IF;
  IF OLD.status IN ('FULFILLED', 'CLOSED', 'CANCELLED') AND NOT (
    NEW.closed_at <=> OLD.closed_at AND
    NEW.closed_by <=> OLD.closed_by AND
    NEW.closed_reason <=> OLD.closed_reason AND
    NEW.cancelled_at <=> OLD.cancelled_at AND
    NEW.cancelled_by <=> OLD.cancelled_by AND
    NEW.cancel_reason_code_id <=> OLD.cancel_reason_code_id AND
    NEW.cancel_comment <=> OLD.cancel_comment AND
    NEW.cancel_approval_request_id <=> OLD.cancel_approval_request_id
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_sales_orders : clôture et annulation figées une fois la commande terminée.';
  END IF;
  IF OLD.released_payment_treatment IS NOT NULL AND NOT (NEW.released_payment_treatment <=> OLD.released_payment_treatment) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_sales_orders : le sort du paiement libéré s''écrit une seule fois.';
  END IF;
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_sales_sales_orders_no_delete` BEFORE DELETE ON `sales_sales_orders` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_sales_orders : suppression physique interdite (INV-GLO-03) ; utiliser CANCELLED.';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `schema_migrations`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `schema_migrations` (
  `version` varchar(128) NOT NULL,
  PRIMARY KEY (`version`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `sync_change_feed`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `sync_change_feed` (
  `seq` bigint unsigned NOT NULL AUTO_INCREMENT,
  `dataset` varchar(40) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `entity_type` varchar(40) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `entity_id` binary(16) NOT NULL,
  `change_type` varchar(20) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `scope_type` varchar(10) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `scope_id` binary(16) DEFAULT NULL,
  `row_version` bigint NOT NULL,
  `recorded_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`seq`),
  KEY `ix_sync_change_feed_scope` (`scope_type`,`scope_id`,`seq`),
  KEY `ix_sync_change_feed_dataset` (`dataset`,`seq`),
  CONSTRAINT `ck_sync_change_feed_change_type` CHECK ((`change_type` in (_utf8mb4'UPSERT',_utf8mb4'DELETE',_utf8mb4'SCOPE_EXIT'))),
  CONSTRAINT `ck_sync_change_feed_scope_type` CHECK ((`scope_type` in (_utf8mb4'GLOBAL',_utf8mb4'SITE',_utf8mb4'ZONE',_utf8mb4'TEAM',_utf8mb4'USER',_utf8mb4'DEVICE',_utf8mb4'LOCATION')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_sync_change_feed_no_update` BEFORE UPDATE ON `sync_change_feed` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sync_change_feed : aucune modification (fait ponctuel en ajout seul).';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `sync_command_inbox`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `sync_command_inbox` (
  `command_id` binary(16) NOT NULL,
  `device_id` binary(16) DEFAULT NULL,
  `user_id` binary(16) NOT NULL,
  `device_seq` bigint DEFAULT NULL,
  `transport` varchar(20) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `command_type` varchar(80) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `command_version` smallint NOT NULL DEFAULT '1',
  `aggregate_type` varchar(40) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `aggregate_id` binary(16) DEFAULT NULL,
  `base_version` int DEFAULT NULL,
  `depends_on` json NOT NULL DEFAULT (json_array()),
  `payload` json NOT NULL,
  `payload_hash` char(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `occurred_at` datetime(6) NOT NULL,
  `client_created_at` datetime(6) DEFAULT NULL,
  `device_sent_at` datetime(6) DEFAULT NULL,
  `received_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `applied_at` datetime(6) DEFAULT NULL,
  `clock_skew_ms` int DEFAULT NULL,
  `captured_offline` tinyint(1) NOT NULL DEFAULT '0',
  `batch_id` binary(16) DEFAULT NULL,
  `status` varchar(25) COLLATE utf8mb4_0900_as_cs NOT NULL DEFAULT 'RECEIVED',
  `result` json DEFAULT NULL,
  `error_code` varchar(60) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `error_message` text COLLATE utf8mb4_0900_as_cs,
  `attempts` smallint NOT NULL DEFAULT '1',
  PRIMARY KEY (`command_id`),
  UNIQUE KEY `uq_sync_command_inbox_device_seq` (`device_id`,`device_seq`),
  KEY `ix_sync_command_inbox_device_received` (`device_id`,`received_at`),
  KEY `ix_sync_command_inbox_user_received` (`user_id`,`received_at`),
  KEY `ix_sync_command_inbox_status` (`status`),
  CONSTRAINT `fk_sync_command_inbox_device` FOREIGN KEY (`device_id`) REFERENCES `identity_devices` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sync_command_inbox_user` FOREIGN KEY (`user_id`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_sync_command_inbox_status` CHECK ((`status` in (_utf8mb4'RECEIVED',_utf8mb4'APPLIED',_utf8mb4'APPLIED_WITH_WARNINGS',_utf8mb4'CONFLICT',_utf8mb4'REJECTED',_utf8mb4'FAILED_RETRYABLE'))),
  CONSTRAINT `ck_sync_command_inbox_transport` CHECK ((`transport` in (_utf8mb4'SYNC_PUSH',_utf8mb4'ONLINE_API',_utf8mb4'SYSTEM')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_sync_command_inbox_update_guard` BEFORE UPDATE ON `sync_command_inbox` FOR EACH ROW BEGIN
  IF NOT (
    NEW.device_id <=> OLD.device_id AND
    NEW.user_id <=> OLD.user_id AND
    NEW.device_seq <=> OLD.device_seq AND
    NEW.transport <=> OLD.transport AND
    NEW.command_type <=> OLD.command_type AND
    NEW.command_version <=> OLD.command_version AND
    NEW.aggregate_type <=> OLD.aggregate_type AND
    NEW.aggregate_id <=> OLD.aggregate_id AND
    NEW.base_version <=> OLD.base_version AND
    NEW.depends_on <=> OLD.depends_on AND
    NEW.payload <=> OLD.payload AND
    NEW.payload_hash <=> OLD.payload_hash AND
    NEW.occurred_at <=> OLD.occurred_at AND
    NEW.client_created_at <=> OLD.client_created_at AND
    NEW.device_sent_at <=> OLD.device_sent_at AND
    NEW.received_at <=> OLD.received_at AND
    NEW.clock_skew_ms <=> OLD.clock_skew_ms AND
    NEW.captured_offline <=> OLD.captured_offline AND
    NEW.batch_id <=> OLD.batch_id
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sync_command_inbox : seuls status/result/error_*/applied_at/attempts sont modifiables (INV-SYN-01).';
  END IF;
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_sync_command_inbox_no_delete` BEFORE DELETE ON `sync_command_inbox` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sync_command_inbox : suppression physique interdite (INV-GLO-03).';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Table structure for table `sync_device_sync_state`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `sync_device_sync_state` (
  `device_id` binary(16) NOT NULL,
  `dataset` varchar(40) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `cursor_seq` bigint NOT NULL DEFAULT '0',
  `last_pull_at` datetime(6) DEFAULT NULL,
  `bootstrapped_at` datetime(6) DEFAULT NULL,
  `needs_rebootstrap` tinyint(1) NOT NULL DEFAULT '0',
  `last_push_at` datetime(6) DEFAULT NULL,
  `last_device_seq` bigint DEFAULT NULL,
  `known_gaps` json DEFAULT NULL,
  `last_clock_skew_ms` int DEFAULT NULL,
  `pending_reported` int DEFAULT NULL,
  `app_version` varchar(20) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  PRIMARY KEY (`device_id`,`dataset`),
  CONSTRAINT `fk_sync_device_sync_state_device` FOREIGN KEY (`device_id`) REFERENCES `identity_devices` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `sync_sync_conflicts`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `sync_sync_conflicts` (
  `id` binary(16) NOT NULL,
  `command_id` binary(16) DEFAULT NULL,
  `conflict_type` varchar(40) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `entity_type` varchar(40) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `entity_id` binary(16) NOT NULL,
  `site_id` binary(16) DEFAULT NULL,
  `owner_role` varchar(40) COLLATE utf8mb4_0900_as_cs NOT NULL,
  `applied` tinyint(1) NOT NULL,
  `details` json NOT NULL,
  `status` varchar(20) COLLATE utf8mb4_0900_as_cs NOT NULL DEFAULT 'OPEN',
  `resolution` varchar(20) COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `resolution_refs` json NOT NULL DEFAULT (json_array()),
  `resolved_by` binary(16) DEFAULT NULL,
  `resolved_at` datetime(6) DEFAULT NULL,
  `resolution_comment` text COLLATE utf8mb4_0900_as_cs,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  KEY `ix_sync_sync_conflicts_status` (`status`,`owner_role`,`site_id`),
  KEY `fk_sync_sync_conflicts_command` (`command_id`),
  KEY `fk_sync_sync_conflicts_site` (`site_id`),
  KEY `fk_sync_sync_conflicts_resolved_by` (`resolved_by`),
  CONSTRAINT `fk_sync_sync_conflicts_command` FOREIGN KEY (`command_id`) REFERENCES `sync_command_inbox` (`command_id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sync_sync_conflicts_resolved_by` FOREIGN KEY (`resolved_by`) REFERENCES `identity_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_sync_sync_conflicts_site` FOREIGN KEY (`site_id`) REFERENCES `organization_sites` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_sync_sync_conflicts_resolution` CHECK (((`resolution` is null) or (`resolution` in (_utf8mb4'ACCEPT_CLIENT',_utf8mb4'KEEP_SERVER',_utf8mb4'MERGE',_utf8mb4'COMPENSATE')))),
  CONSTRAINT `ck_sync_sync_conflicts_status` CHECK ((`status` in (_utf8mb4'OPEN',_utf8mb4'RESOLVED',_utf8mb4'DISMISSED')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_sync_sync_conflicts_update_guard` BEFORE UPDATE ON `sync_sync_conflicts` FOR EACH ROW BEGIN
  IF OLD.status IN ('RESOLVED', 'DISMISSED') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sync_sync_conflicts : immuable après résolution.';
  END IF;
  IF NOT (
    NEW.command_id <=> OLD.command_id AND
    NEW.conflict_type <=> OLD.conflict_type AND
    NEW.entity_type <=> OLD.entity_type AND
    NEW.entity_id <=> OLD.entity_id AND
    NEW.site_id <=> OLD.site_id AND
    NEW.owner_role <=> OLD.owner_role AND
    NEW.applied <=> OLD.applied AND
    NEW.details <=> OLD.details AND
    NEW.created_at <=> OLD.created_at
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sync_sync_conflicts : seule la résolution est modifiable avant clôture.';
  END IF;
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_general_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`gic_migrator`@`%`*/ /*!50003 TRIGGER `trg_sync_sync_conflicts_no_delete` BEFORE DELETE ON `sync_sync_conflicts` FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sync_sync_conflicts : suppression physique interdite (INV-GLO-03).';
END */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

--
-- Dumping routines for database 'gic_agropelc_dev'
--
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

-- Dump completed

--
-- Dbmate schema migrations
--

LOCK TABLES `schema_migrations` WRITE;
INSERT INTO `schema_migrations` (version) VALUES
  ('20260924100000'),
  ('20260924100100'),
  ('20260924100200'),
  ('20260924100300'),
  ('20260924100400'),
  ('20260924100500'),
  ('20260924100600'),
  ('20260924100700'),
  ('20260924110000'),
  ('20260924120000'),
  ('20260924130000'),
  ('20260925090000'),
  ('20260925090100'),
  ('20260926090000'),
  ('20260926090100'),
  ('20260926090200'),
  ('20260927090000'),
  ('20260927090100'),
  ('20260927090200'),
  ('20260927090300'),
  ('20260927090400'),
  ('20260928090000'),
  ('20260929090000'),
  ('20260930090000'),
  ('20260930090100'),
  ('20261001090000'),
  ('20261001090100'),
  ('20261002090000'),
  ('20261002090100'),
  ('20261002090200'),
  ('20261003090000'),
  ('20261003090100'),
  ('20261003090200'),
  ('20261003090300'),
  ('20261003090400'),
  ('20261003090500'),
  ('20261003090600'),
  ('20261003090700'),
  ('20261003090800'),
  ('20261003090900'),
  ('20261003091000');
UNLOCK TABLES;
