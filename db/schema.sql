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
  CONSTRAINT `ck_approvals_control_policies_operation_type` CHECK ((`operation_type` in (_utf8mb4'LOSS_DECLARATION',_utf8mb4'MORTALITY',_utf8mb4'INVENTORY_ADJUSTMENT',_utf8mb4'TRANSFER_DISCREPANCY',_utf8mb4'EXPENSE',_utf8mb4'PURCHASE_REQUEST',_utf8mb4'PURCHASE_ORDER',_utf8mb4'RECEIPT_WITHOUT_PO',_utf8mb4'RECEIPT_VALUE',_utf8mb4'SUPPLIER_PAYMENT',_utf8mb4'PRICE_OVERRIDE',_utf8mb4'SALE_CANCELLATION',_utf8mb4'CREDIT_LIMIT_EXCEEDED',_utf8mb4'CASH_VARIANCE',_utf8mb4'CHECKIN_OVERRIDE',_utf8mb4'RECEIPT_QUARANTINE',_utf8mb4'RECEIPT_CANCELLATION'))),
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
  `cost_type` varchar(20) COLLATE utf8mb4_0900_as_cs NOT NULL,
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
  CONSTRAINT `ck_inventory_cost_entries_cost_type` CHECK ((`cost_type` in (_utf8mb4'ANIMAUX',_utf8mb4'OEUFS',_utf8mb4'ALIMENT',_utf8mb4'VETERINAIRE',_utf8mb4'AUTRE_INTRANT',_utf8mb4'DEPENSE_DIRECTE',_utf8mb4'AJUSTEMENT'))),
  CONSTRAINT `ck_inventory_cost_entries_direction` CHECK ((`direction` in (_utf8mb4'DEBIT',_utf8mb4'CREDIT'))),
  CONSTRAINT `ck_inventory_cost_entries_source_type` CHECK ((`source_type` in (_utf8mb4'STOCK_MOVE',_utf8mb4'EXPENSE',_utf8mb4'MANUAL')))
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
  CONSTRAINT `ck_inventory_loss_declarations_mortality` CHECK (((`category` <> _utf8mb4'MORTALITE') or (`production_lot_id` is not null))),
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
  CONSTRAINT `ck_inventory_stock_lots_origin_type` CHECK ((`origin_type` in (_utf8mb4'PRODUCTION_LOT',_utf8mb4'INCUBATION_BATCH',_utf8mb4'SUPPLIER_LOT',_utf8mb4'COLLECTION'))),
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
  `created_by` binary(16) NOT NULL,
  `created_device_id` binary(16) DEFAULT NULL,
  `command_id` binary(16) DEFAULT NULL,
  `captured_offline` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_inventory_stock_moves_reverses` (`reverses_move_id`),
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
  CONSTRAINT `fk_inventory_stock_moves_product` FOREIGN KEY (`product_id`) REFERENCES `catalog_products` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_stock_moves_reason` FOREIGN KEY (`reason_code_id`) REFERENCES `catalog_reason_codes` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_stock_moves_reverses` FOREIGN KEY (`reverses_move_id`) REFERENCES `inventory_stock_moves` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_inventory_stock_moves_to` FOREIGN KEY (`to_location_id`) REFERENCES `organization_locations` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_inventory_stock_moves_cost_object` CHECK (((`cost_object_type` is null) or (`cost_object_type` in (_utf8mb4'PRODUCTION_LOT',_utf8mb4'INCUBATION_BATCH',_utf8mb4'SITE')))),
  CONSTRAINT `ck_inventory_stock_moves_locations` CHECK ((`from_location_id` <> `to_location_id`)),
  CONSTRAINT `ck_inventory_stock_moves_move_type` CHECK ((`move_type` in (_utf8mb4'OPENING_BALANCE',_utf8mb4'PURCHASE_RECEIPT',_utf8mb4'SUPPLIER_RETURN',_utf8mb4'TRANSFER_DISPATCH',_utf8mb4'TRANSFER_RECEIPT',_utf8mb4'TRANSFER_DISCREPANCY',_utf8mb4'INTERNAL_MOVE',_utf8mb4'SALE',_utf8mb4'CUSTOMER_RETURN',_utf8mb4'LOSS',_utf8mb4'LOSS_PENDING',_utf8mb4'LOSS_CONFIRMATION',_utf8mb4'LOSS_RELEASE',_utf8mb4'CONSUMPTION',_utf8mb4'CONSUMPTION_REVERSAL',_utf8mb4'PRODUCTION_OUTPUT',_utf8mb4'PRODUCTION_INPUT',_utf8mb4'INVENTORY_GAIN',_utf8mb4'INVENTORY_LOSS'))),
  CONSTRAINT `ck_inventory_stock_moves_quantity` CHECK ((`quantity` > 0)),
  CONSTRAINT `ck_inventory_stock_moves_reversal` CHECK ((((`is_reversal` = false) and (`reverses_move_id` is null)) or ((`is_reversal` = true) and (`reverses_move_id` is not null)))),
  CONSTRAINT `ck_inventory_stock_moves_source_doc_type` CHECK ((`source_doc_type` in (_utf8mb4'SALE',_utf8mb4'TRANSFER',_utf8mb4'LOSS',_utf8mb4'CONSUMPTION',_utf8mb4'INVENTORY_COUNT',_utf8mb4'GOODS_RECEIPT',_utf8mb4'EGG_COLLECTION',_utf8mb4'INCUBATION_EVENT',_utf8mb4'LOT_ENTRY'))),
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
  `is_virtual` tinyint(1) GENERATED ALWAYS AS ((`location_type` in (_utf8mb4'V_OPENING',_utf8mb4'V_SUPPLIER',_utf8mb4'V_CUSTOMER',_utf8mb4'V_PRODUCTION',_utf8mb4'V_CONSUMPTION',_utf8mb4'V_LOSS',_utf8mb4'V_PENDING_LOSS',_utf8mb4'V_ADJUSTMENT',_utf8mb4'V_TRANSIT'))) STORED,
  `active_virtual_type` varchar(20) COLLATE utf8mb4_0900_as_cs GENERATED ALWAYS AS (if(((`location_type` in (_utf8mb4'V_OPENING',_utf8mb4'V_SUPPLIER',_utf8mb4'V_CUSTOMER',_utf8mb4'V_PRODUCTION',_utf8mb4'V_CONSUMPTION',_utf8mb4'V_LOSS',_utf8mb4'V_PENDING_LOSS',_utf8mb4'V_ADJUSTMENT',_utf8mb4'V_TRANSIT')) and (`status` = _utf8mb4'ACTIVE')),`location_type`,NULL)) STORED,
  `active_mobile_custodian` binary(16) GENERATED ALWAYS AS (if(((`location_type` = _utf8mb4'MOBILE') and (`status` = _utf8mb4'ACTIVE')),`custodian_user_id`,NULL)) STORED,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_organization_locations_site_code` (`site_id`,`code`),
  UNIQUE KEY `uq_organization_locations_active_virtual_type` (`active_virtual_type`),
  UNIQUE KEY `uq_organization_locations_active_mobile_custodian` (`active_mobile_custodian`),
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
  CONSTRAINT `ck_organization_locations_type` CHECK ((`location_type` in (_utf8mb4'STORE',_utf8mb4'POS',_utf8mb4'BUILDING',_utf8mb4'PEN',_utf8mb4'INCUBATOR',_utf8mb4'HATCHER',_utf8mb4'MOBILE',_utf8mb4'V_OPENING',_utf8mb4'V_SUPPLIER',_utf8mb4'V_CUSTOMER',_utf8mb4'V_PRODUCTION',_utf8mb4'V_CONSUMPTION',_utf8mb4'V_LOSS',_utf8mb4'V_PENDING_LOSS',_utf8mb4'V_ADJUSTMENT',_utf8mb4'V_TRANSIT'))),
  CONSTRAINT `ck_organization_locations_virtual_site` CHECK ((((`is_virtual` = true) and (`site_id` is null)) or ((`is_virtual` = false) and (`site_id` is not null))))
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
-- Dumping routines for database 'gic_agropelc_test'
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
  ('20261001090100');
UNLOCK TABLES;
