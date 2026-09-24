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
  CONSTRAINT `ck_approvals_control_policies_operation_type` CHECK ((`operation_type` in (_utf8mb4'LOSS_DECLARATION',_utf8mb4'MORTALITY',_utf8mb4'INVENTORY_ADJUSTMENT',_utf8mb4'TRANSFER_DISCREPANCY',_utf8mb4'EXPENSE',_utf8mb4'PURCHASE_REQUEST',_utf8mb4'PURCHASE_ORDER',_utf8mb4'RECEIPT_WITHOUT_PO',_utf8mb4'RECEIPT_VALUE',_utf8mb4'SUPPLIER_PAYMENT',_utf8mb4'PRICE_OVERRIDE',_utf8mb4'SALE_CANCELLATION',_utf8mb4'CREDIT_LIMIT_EXCEEDED',_utf8mb4'CASH_VARIANCE',_utf8mb4'CHECKIN_OVERRIDE'))),
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
  CONSTRAINT `ck_identity_auth_sessions_revoked_reason` CHECK (((`revoked_reason` is null) or (`revoked_reason` in (_utf8mb4'LOGOUT',_utf8mb4'ADMIN',_utf8mb4'USER_DEACTIVATED',_utf8mb4'DEVICE_BLOCKED',_utf8mb4'TOKEN_REUSE',_utf8mb4'EXPIRED'))))
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
-- Table structure for table `schema_migrations`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `schema_migrations` (
  `version` varchar(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (`version`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
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
  ('20260924100700');
UNLOCK TABLES;
